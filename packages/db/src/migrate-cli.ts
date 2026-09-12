import pg from 'pg';
import { z } from 'zod';
import { DEFAULT_ALARM_RULES, DEMO_STAND, DEVICE_PROFILES } from '@fieldstream/device-profiles';
import { connectionUrl } from './setup/connection.js';
import { runMigrations } from './setup/migrate.js';
import { ROLES, bootstrapDatabase } from './setup/roles.js';
import { syncAlarmRules } from './store/alarms.js';
import { syncTopology } from './store/topology.js';
import { seedDemoUsers } from './store/users.js';
import type { DemoUser } from './store/users.js';

const secret = z.string().min(1, 'пароль обязателен, значения по умолчанию нет');

const envSchema = z.object({
  DATABASE_HOST: z.string().min(1).default('timescaledb'),
  DATABASE_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  POSTGRES_DB: z.string().min(1).default('fieldstream'),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: secret,
  FS_MIGRATOR_PASSWORD: secret,
  FS_INGEST_PASSWORD: secret,
  FS_API_PASSWORD: secret,
  MIGRATE_DIRECTION: z.enum(['up', 'down']).default('up'),
  DEMO_PASSWORD: z.string().min(8).default('fieldstream'),
});

/** Учётные записи стенда: по одной на роль, чтобы разницу прав было видно сразу. */
const demoUsers = (password: string): DemoUser[] => [
  { email: 'viewer@fieldstream.local', displayName: 'Наблюдатель', role: 'viewer', password },
  { email: 'engineer@fieldstream.local', displayName: 'Инженер', role: 'engineer', password },
  { email: 'admin@fieldstream.local', displayName: 'Администратор', role: 'admin', password },
];

/** Строка лога в JSON: у одноразового контейнера нет смысла тянуть логгер сервиса. */
const say = (message: string, fields: Record<string, unknown> = {}): void => {
  process.stdout.write(`${JSON.stringify({ service: 'migrator', msg: message, ...fields })}\n`);
};

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
  process.stderr.write(`migrator: неверное окружение\n${lines.join('\n')}\n`);
  process.exit(1);
}
const env = parsed.data;
const target = { host: env.DATABASE_HOST, port: env.DATABASE_PORT, database: env.POSTGRES_DB };

const superuser = new pg.Client({
  connectionString: connectionUrl(target, env.POSTGRES_USER, env.POSTGRES_PASSWORD),
});
await superuser.connect();
try {
  await bootstrapDatabase(superuser, env.POSTGRES_DB, {
    migrator: env.FS_MIGRATOR_PASSWORD,
    ingest: env.FS_INGEST_PASSWORD,
    api: env.FS_API_PASSWORD,
  });
  say('роли, расширения и схемы на месте', { roles: Object.values(ROLES) });
} finally {
  await superuser.end();
}

const migratorUrl = connectionUrl(target, ROLES.migrator, env.FS_MIGRATOR_PASSWORD);
const applied = await runMigrations({ databaseUrl: migratorUrl, direction: env.MIGRATE_DIRECTION });
say('миграции применены', { direction: env.MIGRATE_DIRECTION, applied });

if (env.MIGRATE_DIRECTION === 'up') {
  const owner = new pg.Client({ connectionString: migratorUrl });
  await owner.connect();
  try {
    await syncTopology(owner, DEMO_STAND, DEVICE_PROFILES);
    say('топология стенда перенесена в базу', {
      devices: DEMO_STAND.devices.length,
      profiles: DEVICE_PROFILES.map(
        (profile) => `${profile.profileKey}@${String(profile.version)}`,
      ),
    });

    const rules = await syncAlarmRules(owner, DEFAULT_ALARM_RULES);
    say('стартовые уставки на месте', { added: rules });

    const users = demoUsers(env.DEMO_PASSWORD);
    const created = await seedDemoUsers(owner, users);
    say('учётные записи стенда на месте', {
      created,
      accounts: users.map((user) => `${user.email} (${user.role})`),
    });
  } finally {
    await owner.end();
  }
}
