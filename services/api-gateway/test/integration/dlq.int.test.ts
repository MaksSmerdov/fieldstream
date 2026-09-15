import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { TOPICS, dlqListResponseSchema, dlqRedriveSchema } from '@fieldstream/contracts';
import type { SessionResponse } from '@fieldstream/contracts';
import { DEMO_STAND, DEVICE_PROFILES } from '@fieldstream/device-profiles';
import {
  ROLES,
  bootstrapDatabase,
  connectionUrl,
  runMigrations,
  seedDemoUsers,
  syncTopology,
} from '@fieldstream/db';
import { createFakeClock } from '@fieldstream/domain';
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
const ENGINEER = 'engineer@fieldstream.local';
const VIEWER = 'viewer@fieldstream.local';

const clock = createFakeClock(Date.now());

let container: StartedPostgreSqlContainer;
let app: NestFastifyApplication;
let pool: pg.Pool;
let admin: pg.Client;
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

const call = async (
  token: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> => {
  const init: RequestInit =
    body === undefined
      ? { headers: { authorization: `Bearer ${token}` } }
      : {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        };
  const response = await fetch(`${base}${path}`, init);

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

  admin = new pg.Client({
    connectionString: connectionUrl(target, SUPERUSER.user, SUPERUSER.password),
  });
  await admin.connect();
  await bootstrapDatabase(admin, 'fieldstream', PASSWORDS);

  await runMigrations({
    databaseUrl: connectionUrl(target, ROLES.migrator, PASSWORDS.migrator),
    direction: 'up',
  });

  const owner = new pg.Client({
    connectionString: connectionUrl(target, ROLES.migrator, PASSWORDS.migrator),
  });
  await owner.connect();
  await syncTopology(owner, DEMO_STAND, DEVICE_PROFILES);
  await seedDemoUsers(owner, [
    { email: ENGINEER, displayName: 'Инженер', role: 'engineer', password: PASSWORD },
    { email: VIEWER, displayName: 'Наблюдатель', role: 'viewer', password: PASSWORD },
  ]);
  await owner.end();

  pool = new pg.Pool({ connectionString: connectionUrl(target, ROLES.api, PASSWORDS.api), max: 4 });
  app = await createApp({
    env: loadEnv({
      FS_API_PASSWORD: PASSWORDS.api,
      AUTH_SECRET: SECRET,
      SSE_BRIDGE: 'off',
      OUTBOX_RELAY: 'off',
      PIPELINE_SAMPLER: 'off',
      COLLECTOR_STATUS: 'off',
    }),
    log: createLogger('api-gateway', 'fatal'),
    clock,
    metrics: createMetrics(),
    pool,
    instanceId: 'test',
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  engineerToken = await login(ENGINEER);
  viewerToken = await login(VIEWER);
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await admin.end();
  await container.stop();
});

describe('очередь недоставленных через шлюз', () => {
  it('очередь листается курсором от новых к старым, до последней страницы', async () => {
    await admin.query(
      `INSERT INTO core.dlq_message (source_topic, partition, "offset", key, payload, error)
       SELECT $1, 4, n, 'RC-102', convert_to('{не json ' || n, 'UTF8'),
              jsonb_build_object('class', 'invalid_json', 'message', 'Unexpected token')
       FROM generate_series(1, 5) AS n`,
      [TOPICS.telemetryRaw.name],
    );

    const pages = [];
    let path = '/api/dlq?limit=2';
    for (;;) {
      const { status, json } = await call(viewerToken, path);
      expect(status).toBe(200);
      const page = dlqListResponseSchema.parse(json);
      pages.push(page);
      if (page.nextCursor === null) break;
      path = `/api/dlq?limit=2&cursor=${page.nextCursor}`;
    }

    expect(pages.map((page) => page.items.map((item) => item.offset))).toEqual([
      ['5', '4'],
      ['3', '2'],
      ['1'],
    ]);
    expect(pages[0]?.items[0]).toMatchObject({
      sourceTopic: TOPICS.telemetryRaw.name,
      partition: 4,
      key: 'RC-102',
      errorClass: 'invalid_json',
      error: 'Unexpected token',
      attempts: 1,
      resolvedAt: null,
      finalRejected: false,
      payloadPreview: '{не json 5',
      payloadBytes: Buffer.byteLength('{не json 5'),
    });
  });

  it('неверный лимит или курсор это ошибка запроса', async () => {
    for (const query of ['limit=0', 'limit=201', 'cursor=abc', 'cursor=-1', 'page=2']) {
      expect((await call(viewerToken, `/api/dlq?${query}`)).status).toBe(400);
    }
  });

  it('наблюдатель видит очередь, но запустить повторную подачу не может', async () => {
    const { status } = await call(viewerToken, '/api/dlq/redrive', { max: 10 });
    const stored = await admin.query<{ n: string }>('SELECT count(*) AS n FROM core.dlq_redrive');

    expect(status).toBe(403);
    expect(stored.rows[0]?.n).toBe('0');
  });

  it('инженер ставит запрос в очередь и читает его по номеру', async () => {
    const created = await call(engineerToken, '/api/dlq/redrive', { max: 20 });
    expect(created.status).toBe(202);
    const request = dlqRedriveSchema.parse(created.json);
    expect(request).toMatchObject({
      status: 'queued',
      maxMessages: 20,
      redriven: 0,
      rejected: 0,
      error: null,
      requestedBy: ENGINEER,
      startedAt: null,
      finishedAt: null,
    });

    const read = await call(viewerToken, `/api/dlq/redrive/${request.id}`);
    expect(read.status).toBe(200);
    expect(dlqRedriveSchema.parse(read.json)).toEqual(request);

    const byDefault = await call(engineerToken, '/api/dlq/redrive', {});
    expect(byDefault.status).toBe(202);
    expect(dlqRedriveSchema.parse(byDefault.json).maxMessages).toBe(50);
  });

  it('неверное тело это 400, неизвестный запрос это 404', async () => {
    for (const body of [
      { max: 0 },
      { max: 501 },
      { max: '10' },
      { max: 1.5 },
      { max: 5, all: true },
    ]) {
      expect((await call(engineerToken, '/api/dlq/redrive', body)).status).toBe(400);
    }

    expect((await call(engineerToken, '/api/dlq/redrive/abc')).status).toBe(400);
    expect((await call(engineerToken, '/api/dlq/redrive/999999')).status).toBe(404);
  });

  it('без токена очередь закрыта', async () => {
    expect((await fetch(`${base}/api/dlq`)).status).toBe(401);
  });
});
