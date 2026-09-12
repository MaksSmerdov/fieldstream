import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { z } from 'zod';
import {
  deviceSnapshotSchema,
  readPlanResponseSchema,
  seriesResponseSchema,
  topologyResponseSchema,
} from '@fieldstream/contracts';
import type { SessionResponse } from '@fieldstream/contracts';
import { DEFAULT_ALARM_RULES, DEMO_STAND, DEVICE_PROFILES } from '@fieldstream/device-profiles';
import {
  ROLES,
  bootstrapDatabase,
  connectionUrl,
  insertReadings,
  runMigrations,
  seedDemoUsers,
  syncAlarmRules,
  syncTopology,
} from '@fieldstream/db';
import type { ReadingRow } from '@fieldstream/db';
import { createFakeClock } from '@fieldstream/domain';
import { createLogger } from '@fieldstream/nest-common';
import { createApp } from '../../src/bootstrap.js';
import { loadEnv } from '../../src/config/env.js';
import { createMetrics } from '../../src/metrics/metrics.js';

const IMAGE = 'timescale/timescaledb-ha:pg16.6-ts2.17.2';
const SUPERUSER = { user: 'postgres', password: 'superuser-pw' };
const PASSWORDS = { migrator: 'migrator-pw', ingest: 'ingest-pw', api: 'api-pw' };
const SECRET = 'секрет стенда длиной не меньше тридцати двух символов';
const PASSWORD = 'пароль стенда';
const DEVICE = 'RC-101';
const METRIC = 'supply_temp_c';

const clock = createFakeClock(Date.now());

let container: StartedPostgreSqlContainer;
let app: NestFastifyApplication;
let pool: pg.Pool;
let owner: pg.Client;
let base: string;
let token: string;
let windowFrom: Date;
let windowTo: Date;

/** Ответ разбирается схемой контракта: тест проверяет не только числа, но и форму ответа. */
const get = async <S extends z.ZodTypeAny>(
  path: string,
  schema: S,
): Promise<{ status: number; body: z.infer<S> | null }> => {
  const response = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const json: unknown = await response.json();

  const body = response.ok ? (schema.parse(json) as z.infer<S>) : null;

  return { status: response.status, body };
};

/** Три часа показаний с неровным числом отсчётов в минуте: так видно вес каждой минуты. */
const seedReadings = async (client: pg.ClientBase, startMs: number): Promise<void> => {
  const rows: ReadingRow[] = [];

  for (let minute = 0; minute < 180; minute += 1) {
    const samples = 1 + ((minute * 7) % 6);
    for (let sample = 0; sample < samples; sample += 1) {
      rows.push({
        ts: new Date(startMs + minute * 60_000 + sample * 7_000).toISOString(),
        deviceId: 1,
        metricKey: METRIC,
        value: -20 + Math.sin(minute / 9) * 3 + sample / 10,
        quality: 0,
      });
    }
  }

  const refs = await client.query<{ id: number }>('SELECT id FROM core.devices WHERE code = $1', [
    DEVICE,
  ]);
  const deviceId = refs.rows[0]?.id;
  if (deviceId === undefined) throw new Error('прибор не найден');

  await insertReadings(
    client,
    rows.map((row) => ({ ...row, deviceId })),
  );
};

beforeAll(async () => {
  container = await new PostgreSqlContainer(IMAGE)
    .withDatabase('fieldstream')
    .withUsername(SUPERUSER.user)
    .withPassword(SUPERUSER.password)
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
  await syncAlarmRules(owner, DEFAULT_ALARM_RULES);
  await seedDemoUsers(owner, [
    {
      email: 'engineer@fieldstream.local',
      displayName: 'Инженер',
      role: 'engineer',
      password: PASSWORD,
    },
  ]);

  const startedAt = await owner.query<{ at: Date }>(
    `SELECT date_trunc('hour', now()) - INTERVAL '4 hours' AS at`,
  );
  windowFrom = startedAt.rows[0]?.at ?? new Date();
  windowTo = new Date(windowFrom.getTime() + 3 * 3_600_000);

  const ingest = new pg.Client({
    connectionString: connectionUrl(target, ROLES.ingest, PASSWORDS.ingest),
  });
  await ingest.connect();
  await seedReadings(ingest, windowFrom.getTime());
  await ingest.end();

  await owner.query(
    `CALL refresh_continuous_aggregate('ts.readings_1m', $1::timestamptz, $2::timestamptz)`,
    [windowFrom.toISOString(), windowTo.toISOString()],
  );

  pool = new pg.Pool({ connectionString: connectionUrl(target, ROLES.api, PASSWORDS.api), max: 4 });
  app = await createApp({
    env: loadEnv({ FS_API_PASSWORD: PASSWORDS.api, AUTH_SECRET: SECRET }),
    log: createLogger('api-gateway', 'fatal'),
    clock,
    metrics: createMetrics(),
    pool,
    instanceId: 'test',
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'engineer@fieldstream.local', password: PASSWORD }),
  });
  token = ((await response.json()) as SessionResponse).accessToken;
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await container.stop();
});

describe('чтение через шлюз', () => {
  it('дерево объектов приходит целиком и с состоянием приборов', async () => {
    const { status, body } = await get('/api/topology', topologyResponseSchema);

    expect(status).toBe(200);
    const devices = (body?.sites ?? []).flatMap((site) =>
      site.gateways.flatMap((gateway) => gateway.lines.flatMap((line) => line.devices)),
    );
    expect(devices).toHaveLength(24);
    expect(devices.every((device) => device.status === 'unknown')).toBe(true);
    expect(devices.every((device) => device.activeAlarms === 0)).toBe(true);
  });

  it('снимок несёт описание метрик и признак устаревания от серверных часов', async () => {
    const { body } = await get(`/api/devices/${DEVICE}/latest`, deviceSnapshotSchema);

    expect(body?.deviceCode).toBe(DEVICE);
    expect(body?.metrics.length).toBeGreaterThan(0);
    const supply = body?.metrics.find((metric) => metric.metricKey === METRIC);
    expect(supply?.unit).toBe('°C');
    expect(supply?.precision).toBe(1);
    expect(body?.stale).toBe(true);
  });

  it('несуществующий прибор это 404, а не пустой снимок', async () => {
    expect((await get('/api/devices/RC-999/latest', deviceSnapshotSchema)).status).toBe(404);
  });

  it('короткое окно читается из сырых строк', async () => {
    const from = new Date(windowFrom.getTime() + 3_600_000).toISOString();
    const to = new Date(windowFrom.getTime() + 2 * 3_600_000).toISOString();
    const { body } = await get(
      `/api/devices/${DEVICE}/series?metrics=${METRIC}&from=${from}&to=${to}&maxPoints=60`,
      seriesResponseSchema,
    );

    expect(body?.meta.source).toBe('readings');
    expect(body?.meta.truncated).toBe(false);
    expect(body?.metrics[0]?.points.length).toBeGreaterThan(0);
  });

  /**
   * Из агрегатов среднее считается взвешенно по числу отсчётов: минуты с одним замером
   * не должны весить столько же, сколько минуты с шестью.
   */
  it('длинное окно читается из минутного агрегата и совпадает с прямым расчётом', async () => {
    const from = new Date(windowFrom.getTime() - 5 * 24 * 3_600_000).toISOString();
    const { body } = await get(
      `/api/devices/${DEVICE}/series?metrics=${METRIC}&from=${from}&to=${windowTo.toISOString()}&maxPoints=200`,
      seriesResponseSchema,
    );

    expect(body?.meta.source).toBe('readings_1m');

    const points = body?.metrics[0]?.points ?? [];
    expect(points.length).toBeGreaterThan(0);

    const direct = await owner.query<{ bucket: Date; avg: string; n: string }>(
      `SELECT time_bucket($3::interval, r.ts) AS bucket, avg(r.value) AS avg, count(*) AS n
       FROM ts.readings r JOIN core.devices d ON d.id = r.device_id
       WHERE d.code = $1 AND r.metric_key = $2 AND r.ts >= $4 AND r.ts < $5
       GROUP BY 1 ORDER BY 1`,
      [
        DEVICE,
        METRIC,
        `${String(body?.meta.bucketMs ?? 60_000)} milliseconds`,
        windowFrom.toISOString(),
        windowTo.toISOString(),
      ],
    );

    for (const row of direct.rows) {
      const point = points.find((item) => item.t === row.bucket.toISOString());
      if (point?.avg == null) continue;
      expect(Math.abs(point.avg - Number(row.avg))).toBeLessThan(1e-6);
    }
  });

  it('перевёрнутое окно это ошибка запроса', async () => {
    const to = windowFrom.toISOString();
    const from = windowTo.toISOString();

    const response = await get(
      `/api/devices/${DEVICE}/series?metrics=${METRIC}&from=${from}&to=${to}`,
      seriesResponseSchema,
    );

    expect(response.status).toBe(400);
  });

  it('склейка блоков видна в карте регистров: четыре запроса вместо девяти', async () => {
    const merged = await get(
      `/api/devices/${DEVICE}/read-plan?mode=merged`,
      readPlanResponseSchema,
    );
    const naive = await get(`/api/devices/${DEVICE}/read-plan?mode=naive`, readPlanResponseSchema);

    expect(merged.body?.requests).toBe(4);
    expect(naive.body?.requests).toBe(9);
    expect(merged.body?.registers).toBe(naive.body?.registers);
  });

  it('без токена чтение закрыто', async () => {
    expect((await fetch(`${base}/api/topology`)).status).toBe(401);
  });
});
