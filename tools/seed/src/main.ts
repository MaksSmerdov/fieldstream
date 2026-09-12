import pg from 'pg';
import { z } from 'zod';
import { ROLES, connectionUrl, updateBootStage } from '@fieldstream/db';
import { SystemClock } from '@fieldstream/domain';
import { compressHistory, refreshAggregates, seedHistory } from './seed.js';

const secret = z.string().min(1, 'пароль обязателен, значения по умолчанию нет');

const envSchema = z.object({
  DATABASE_HOST: z.string().min(1).default('timescaledb'),
  DATABASE_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  POSTGRES_DB: z.string().min(1).default('fieldstream'),
  FS_MIGRATOR_PASSWORD: secret,
  SEED_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  SEED_COMPRESS: z.enum(['on', 'off']).default('on'),
});

/** Строка лога в JSON: у одноразового контейнера нет смысла тянуть логгер сервиса. */
const say = (message: string, fields: Record<string, unknown> = {}): void => {
  process.stdout.write(`${JSON.stringify({ service: 'seed', msg: message, ...fields })}\n`);
};

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
  process.stderr.write(`seed: неверное окружение\n${lines.join('\n')}\n`);
  process.exit(1);
}
const env = parsed.data;

const client = new pg.Client({
  connectionString: connectionUrl(
    { host: env.DATABASE_HOST, port: env.DATABASE_PORT, database: env.POSTGRES_DB },
    ROLES.migrator,
    env.FS_MIGRATOR_PASSWORD,
  ),
});
await client.connect();

try {
  await updateBootStage(client, { stage: 'history', status: 'running', progressPct: 0 });
  const startedAt = SystemClock.now();

  await client.query('BEGIN');
  const report = await seedHistory(client, {
    days: env.SEED_DAYS,
    until: new Date(SystemClock.now()),
    onProgress: (stage, done, total) => {
      if (done % 5 === 0 || done === total) say('засев идёт', { stage, done, total });
    },
  });
  await client.query('COMMIT');
  say('история засеяна', {
    ...report,
    seconds: Math.round((SystemClock.now() - startedAt) / 1000),
  });

  await updateBootStage(client, { stage: 'history', status: 'running', progressPct: 60 });
  await refreshAggregates(client, report.from, report.to);
  say('агрегаты пересчитаны на засеянном окне');

  if (env.SEED_COMPRESS === 'on') {
    await updateBootStage(client, { stage: 'history', status: 'running', progressPct: 80 });
    const compression = await compressHistory(client);
    say('сжатие применено', {
      chunks: compression.chunks,
      beforeMb: Math.round(compression.beforeBytes / 1_048_576),
      afterMb: Math.round(compression.afterBytes / 1_048_576),
      ratio: compression.ratio,
    });
  }

  await updateBootStage(client, {
    stage: 'history',
    status: 'done',
    progressPct: 100,
    detail: `${String(env.SEED_DAYS)} суток истории`,
  });
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  await updateBootStage(client, {
    stage: 'history',
    status: 'failed',
    detail: error instanceof Error ? error.message : String(error),
  }).catch(() => undefined);
  process.stderr.write(`seed: засев не удался\n${String(error)}\n`);
  process.exitCode = 1;
} finally {
  await client.end();
}
