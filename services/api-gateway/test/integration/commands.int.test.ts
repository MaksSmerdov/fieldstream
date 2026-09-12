import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { TOPICS, commandAcceptedSchema, commandProgressSchema } from '@fieldstream/contracts';
import type { SessionResponse } from '@fieldstream/contracts';
import { DEMO_STAND, DEVICE_PROFILES } from '@fieldstream/device-profiles';
import {
  ROLES,
  bootstrapDatabase,
  claimOutbox,
  connectionUrl,
  recordAppliedCommand,
  runMigrations,
  seedDemoUsers,
  syncTopology,
} from '@fieldstream/db';
import { createFakeClock, toIsoTimestamp } from '@fieldstream/domain';
import { createLogger } from '@fieldstream/nest-common';
import { createApp } from '../../src/bootstrap.js';
import { loadEnv } from '../../src/config/env.js';
import { createMetrics } from '../../src/metrics/metrics.js';

const IMAGE = 'timescale/timescaledb-ha:pg16.6-ts2.17.2';
/** Планировщик TimescaleDB выключен: политики просыпаются посреди теста, а агрегаты тесты обновляют сами. */
const NO_BACKGROUND_JOBS = ['postgres', '-c', 'timescaledb.max_background_workers=0'];
const SUPERUSER = { user: 'postgres', password: 'superuser-pw' };
const PASSWORDS = { migrator: 'migrator-pw', ingest: 'ingest-pw', api: 'api-pw' };
const SECRET = 'секрет стенда длиной не меньше тридцати двух символов';
const PASSWORD = 'пароль стенда';

const clock = createFakeClock(Date.now());

let container: StartedPostgreSqlContainer;
let app: NestFastifyApplication;
let pool: pg.Pool;
let owner: pg.Client;
let ingest: pg.Client;
let base: string;
let engineerToken: string;
let viewerToken: string;

const login = async (email: string): Promise<string> => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });

  return ((await response.json()) as SessionResponse).accessToken;
};

const send = async (token: string, body: unknown): Promise<{ status: number; json: unknown }> => {
  const response = await fetch(`${base}/api/commands`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return { status: response.status, json: await response.json().catch(() => null) };
};

const progressOf = async (commandId: string): Promise<{ status: number; json: unknown }> => {
  const response = await fetch(`${base}/api/commands/${commandId}`, {
    headers: { authorization: `Bearer ${engineerToken}` },
  });

  return { status: response.status, json: await response.json().catch(() => null) };
};

beforeAll(async () => {
  container = await new PostgreSqlContainer(IMAGE)
    .withDatabase('fieldstream')
    .withUsername(SUPERUSER.user)
    .withPassword(SUPERUSER.password)
    .withCommand(NO_BACKGROUND_JOBS)
    .start();
  const target = { host: container.getHost(), port: container.getPort(), database: 'fieldstream' };

  const admin = new pg.Client({
    connectionString: connectionUrl(target, SUPERUSER.user, SUPERUSER.password),
  });
  await admin.connect();
  await bootstrapDatabase(admin, 'fieldstream', PASSWORDS);
  await admin.end();

  await runMigrations({
    databaseUrl: connectionUrl(target, ROLES.migrator, PASSWORDS.migrator),
    direction: 'up',
  });

  owner = new pg.Client({
    connectionString: connectionUrl(target, ROLES.migrator, PASSWORDS.migrator),
  });
  await owner.connect();
  await syncTopology(owner, DEMO_STAND, DEVICE_PROFILES);
  await seedDemoUsers(owner, [
    {
      email: 'engineer@fieldstream.local',
      displayName: 'Инженер',
      role: 'engineer',
      password: PASSWORD,
    },
    {
      email: 'viewer@fieldstream.local',
      displayName: 'Наблюдатель',
      role: 'viewer',
      password: PASSWORD,
    },
  ]);

  ingest = new pg.Client({
    connectionString: connectionUrl(target, ROLES.ingest, PASSWORDS.ingest),
  });
  await ingest.connect();

  pool = new pg.Pool({ connectionString: connectionUrl(target, ROLES.api, PASSWORDS.api), max: 4 });
  app = await createApp({
    env: loadEnv({
      FS_API_PASSWORD: PASSWORDS.api,
      AUTH_SECRET: SECRET,
      SSE_BRIDGE: 'off',
      OUTBOX_RELAY: 'off',
    }),
    log: createLogger('api-gateway', 'fatal'),
    clock,
    metrics: createMetrics(),
    pool,
    instanceId: 'test',
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  engineerToken = await login('engineer@fieldstream.local');
  viewerToken = await login('viewer@fieldstream.local');
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await ingest.end();
  await owner.end();
  await container.stop();
});

describe('команды через очередь исходящих', () => {
  it('принятая команда ложится в очередь, а не уходит в брокер прямо из запроса', async () => {
    const { status, json } = await send(engineerToken, {
      lineCode: 'L1',
      kind: 'line.set_poll_interval',
      args: { pollIntervalMs: 15_000 },
    });
    const accepted = commandAcceptedSchema.parse(json);

    expect(status).toBe(202);

    const row = await owner.query<{ topic: string; msg_key: string; published_at: Date | null }>(
      'SELECT topic, msg_key, published_at FROM core.outbox WHERE aggregate_id = $1',
      [accepted.commandId],
    );
    expect(row.rows[0]?.topic).toBe(TOPICS.deviceCommands.name);
    expect(row.rows[0]?.msg_key).toBe('SITE-A');
    expect(row.rows[0]?.published_at).toBeNull();

    const progress = commandProgressSchema.parse((await progressOf(accepted.commandId)).json);
    expect(progress.stage).toBe('queued');
  });

  it('команда неизвестной линии отвергается, а не копится в очереди', async () => {
    const response = await send(engineerToken, { lineCode: 'L9', kind: 'line.enable' });

    expect(response.status).toBe(404);
  });

  it('команде смены такта нужен сам такт', async () => {
    const response = await send(engineerToken, { lineCode: 'L1', kind: 'line.set_poll_interval' });

    expect(response.status).toBe(400);
  });

  it('наблюдатель команды слать не может', async () => {
    const response = await send(viewerToken, { lineCode: 'L1', kind: 'line.enable' });

    expect(response.status).toBe(403);
  });

  /** Отправку делает фоновая рассылка: она забирает строку под свою блокировку. */
  it('рассылка забирает строку из очереди и помечает отправленной', async () => {
    const { json } = await send(engineerToken, { lineCode: 'L2', kind: 'line.disable' });
    const accepted = commandAcceptedSchema.parse(json);

    const claimed = await claimOutbox(owner, 'ce9f1f6c-9a2d-4a58-9f0b-2c0d1f7a5e31', 10);
    expect(claimed.some((row) => row.msgKey === 'SITE-A' || row.msgKey === 'SITE-B')).toBe(true);

    await owner.query('UPDATE core.outbox SET published_at = now() WHERE aggregate_id = $1', [
      accepted.commandId,
    ]);

    const sent = commandProgressSchema.parse((await progressOf(accepted.commandId)).json);
    expect(sent.stage).toBe('sent');
    expect(sent.attempts).toBeGreaterThan(0);
  });

  /** Факт применения пишет процессор, прочитав ответ исполнителя из брокера. */
  it('после ответа исполнителя команда показывается применённой', async () => {
    const { json } = await send(engineerToken, {
      lineCode: 'L1',
      kind: 'line.plan_mode',
      args: { planMode: 'naive' },
    });
    const accepted = commandAcceptedSchema.parse(json);

    await owner.query('UPDATE core.outbox SET published_at = now() WHERE aggregate_id = $1', [
      accepted.commandId,
    ]);
    const written = await recordAppliedCommand(ingest, {
      commandId: accepted.commandId,
      lineCode: 'L1',
      kind: 'line.plan_mode',
      args: {},
      appliedAt: toIsoTimestamp(clock.now()),
      result: { status: 'applied', detail: 'план чтения линии L1 теперь naive' },
    });
    expect(written).toBe(true);

    const progress = commandProgressSchema.parse((await progressOf(accepted.commandId)).json);
    expect(progress.stage).toBe('applied');
    expect(progress.detail).toContain('naive');

    const again = await recordAppliedCommand(ingest, {
      commandId: accepted.commandId,
      lineCode: 'L1',
      kind: 'line.plan_mode',
      args: {},
      appliedAt: toIsoTimestamp(clock.now()),
      result: { status: 'applied', detail: 'повтор ответа' },
    });
    expect(again).toBe(false);
  });

  it('неизвестной команды нет, а не пустой статус', async () => {
    const response = await progressOf('00000000-0000-4000-8000-000000000000');

    expect(response.status).toBe(404);
  });
});
