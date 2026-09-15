import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scenarioRunSchema, scenariosResponseSchema } from '@fieldstream/contracts';
import type {
  BreakerState,
  LineStatus,
  ScenarioRun,
  SessionResponse,
  SimFault,
} from '@fieldstream/contracts';
import { DEMO_STAND, DEVICE_PROFILES } from '@fieldstream/device-profiles';
import {
  ROLES,
  bootstrapDatabase,
  connectionUrl,
  runMigrations,
  seedDemoUsers,
  syncTopology,
} from '@fieldstream/db';
import { SystemClock, toIsoTimestamp } from '@fieldstream/domain';
import { createLogger } from '@fieldstream/nest-common';
import { createApp } from '../../src/bootstrap.js';
import { loadEnv } from '../../src/config/env.js';
import { LineStatusService } from '../../src/lab/line-status.service.js';
import { createMetrics } from '../../src/metrics/metrics.js';
import { ScenariosService } from '../../src/scenarios/scenarios.service.js';

const IMAGE = 'timescale/timescaledb-ha:pg16.6-ts2.17.2';
const NO_BACKGROUND_JOBS = ['postgres', '-c', 'timescaledb.max_background_workers=0'];
const SUPERUSER = { user: 'postgres', password: 'superuser-pw' };
const PASSWORDS = { migrator: 'migrator-pw', ingest: 'ingest-pw', api: 'api-pw' };
const SECRET = 'секрет стенда длиной не меньше тридцати двух символов';
const PASSWORD = 'пароль стенда';
const CLEARED = 'DELETE /sim/faults?targetId=RC-105&kind=silent';

/** Короткие сценарии: размыкатель RC-105 управляется снимками линии прямо из теста. */
const SCENARIOS: Readonly<Record<string, string>> = {
  'breaker-trip': `
name: breaker-trip
title: Размыкатель на молчащем приборе
description: RC-105 молчит, размыкатель отсекает его и возвращает после снятия поломки.
timeoutSec: 30
steps:
  - inject: { targetKind: device, targetId: RC-105, kind: silent, ttlSec: 120 }
  - waitFor:
      probe: { breaker: { deviceCode: RC-105, state: open } }
      timeoutSec: 12
  - clear: { targetId: RC-105, kind: silent }
  - waitFor:
      probe: { breaker: { deviceCode: RC-105, state: closed } }
      timeoutSec: 12
`,
  'breaker-stuck': `
name: breaker-stuck
title: Размыкатель не размыкается
description: RC-105 молчит, но размыкатель так и не срабатывает.
timeoutSec: 5
steps:
  - inject: { targetKind: device, targetId: RC-105, kind: silent, ttlSec: 60 }
  - waitFor:
      probe: { breaker: { deviceCode: RC-105, state: open } }
      timeoutSec: 2
`,
  'breaker-hold': `
name: breaker-hold
title: Размыкатель держится
description: RC-105 молчит, а размыкатель долго остаётся замкнутым.
timeoutSec: 120
steps:
  - inject: { targetKind: device, targetId: RC-105, kind: silent, ttlSec: 120 }
  - hold:
      probe: { breaker: { deviceCode: RC-105, state: closed } }
      forSec: 100
`,
};

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const recorded: Recorded[] = [];

let container: StartedPostgreSqlContainer;
let owner: pg.Client;
let pool: pg.Pool;
let sim: Server;
let app: NestFastifyApplication;
let appClosed = false;
let lines: LineStatusService;
let dir: string;
let base: string;
let viewer: string;
let engineer: string;
let staleId: string;
let snapshotSeq = 0;

/** Поддельный стенд: записывает запросы, вносит и снимает поломки. */
const handle = (request: IncomingMessage, response: ServerResponse): void => {
  let raw = '';
  request.on('data', (chunk: Buffer) => {
    raw += chunk.toString('utf8');
  });
  request.on('end', () => {
    const method = request.method ?? '';
    const url = request.url ?? '';
    recorded.push({ method, url, body: raw.length > 0 ? (JSON.parse(raw) as unknown) : null });

    const now = SystemClock.now();
    const fault: SimFault = {
      id: `fault-${String(recorded.length)}`,
      targetKind: 'device',
      targetId: 'RC-105',
      kind: 'silent',
      since: toIsoTimestamp(now),
      expiresAt: toIsoTimestamp(now + 120_000),
      exceptionCode: null,
      paramKey: null,
    };
    const [status, body] =
      method === 'POST' && url === '/sim/fault'
        ? [201, fault]
        : method === 'DELETE' && url.startsWith('/sim/faults')
          ? [200, { removed: 1 }]
          : [404, { type: 'about:blank', title: 'Нет маршрута', status: 404, detail: 'нет' }];

    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
};

/** Снимок линии L2 с заданным состоянием размыкателя RC-105; моменты растут. */
const recordBreaker = (state: BreakerState): void => {
  snapshotSeq += 1;
  const ts = toIsoTimestamp(SystemClock.now() + snapshotSeq);
  const status: LineStatus = {
    schema: 'line.status',
    v: 1,
    ts,
    lineCode: 'L2',
    running: true,
    connected: true,
    planMode: 'merged',
    pollIntervalMs: 10_000,
    requestTimeoutMs: 600,
    hardTimeoutMs: 1_450,
    watchdog: { limitMs: 300_000, cycleStartedAt: null, trips: 0 },
    lastCycle: { at: ts, outcome: 'polled', durationMs: 420, polled: 6, failed: 0 },
    reconnects: [],
    devices: [
      {
        deviceCode: 'RC-105',
        slaveId: 5,
        breaker: { state, failures: state === 'open' ? 2 : 0, probeDelayMs: 0, nextProbeAt: null },
      },
    ],
    latency: {
      bucketsMs: [50, 100],
      counts: [10, 2, 0],
      samples: 12,
      timeouts: 0,
      p50Ms: 40,
      p95Ms: 90,
      p99Ms: 95,
      suggestedTimeoutMs: null,
    },
  };

  lines.record(status);
};

const call = async (
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });

  return { status: response.status, json: await response.json().catch(() => null) };
};

const login = async (email: string): Promise<string> => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return ((await response.json()) as SessionResponse).accessToken;
};

const readRun = async (id: string): Promise<ScenarioRun> => {
  const { status, json } = await call(viewer, 'GET', `/api/scenario-runs/${id}`);
  expect(status).toBe(200);
  return scenarioRunSchema.parse(json);
};

/** Опрашивает прогон через API, пока условие не выполнится. */
const waitForRun = async (
  id: string,
  until: (run: ScenarioRun) => boolean,
  timeoutMs = 20_000,
): Promise<ScenarioRun> => {
  const deadline = SystemClock.now() + timeoutMs;

  for (;;) {
    const run = await readRun(id);
    if (until(run)) return run;
    if (SystemClock.now() >= deadline) {
      throw new Error(`прогон не дошёл до ожидаемого состояния: ${JSON.stringify(run)}`);
    }
    await delay(100);
  }
};

const finished = (run: ScenarioRun): boolean => run.status === 'passed' || run.status === 'failed';

const startRun = async (name: string, body: unknown = {}): Promise<ScenarioRun> => {
  const { status, json } = await call(engineer, 'POST', `/api/scenarios/${name}/run`, body);
  expect(status).toBe(202);
  return scenarioRunSchema.parse(json);
};

const simCalls = (): string[] => recorded.map((request) => `${request.method} ${request.url}`);

/** Ждёт, пока условие выполнится. */
const waitUntil = async (check: () => boolean, timeoutMs = 20_000): Promise<void> => {
  const deadline = SystemClock.now() + timeoutMs;

  while (!check()) {
    if (SystemClock.now() >= deadline) throw new Error('условие не выполнилось вовремя');
    await delay(100);
  }
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
      email: 'viewer@fieldstream.local',
      displayName: 'Наблюдатель',
      role: 'viewer',
      password: PASSWORD,
    },
    {
      email: 'engineer@fieldstream.local',
      displayName: 'Инженер',
      role: 'engineer',
      password: PASSWORD,
    },
  ]);

  const stale = await owner.query<{ id: string }>(
    `INSERT INTO core.scenario_run (scenario, title, source, requested_by, status, steps, started_at)
     VALUES ('dead-device', 'Мёртвый прибор', 'ui', 'engineer@fieldstream.local', 'running', $1::jsonb,
             now())
     RETURNING id`,
    [
      JSON.stringify([
        {
          index: 0,
          kind: 'inject',
          title: 'Внести поломку',
          status: 'running',
          startedAt: toIsoTimestamp(SystemClock.now()),
          finishedAt: null,
          detail: null,
        },
        {
          index: 1,
          kind: 'clear',
          title: 'Снять поломку',
          status: 'pending',
          startedAt: null,
          finishedAt: null,
          detail: null,
        },
      ]),
    ],
  );
  staleId = stale.rows[0]?.id ?? '';

  dir = await mkdtemp(join(tmpdir(), 'fieldstream-scenarios-'));
  for (const [name, text] of Object.entries(SCENARIOS)) {
    await writeFile(join(dir, `${name}.yaml`), text.trimStart(), 'utf8');
  }

  sim = createServer(handle);
  await new Promise<void>((resolve) => {
    sim.listen(0, '127.0.0.1', resolve);
  });
  const { port } = sim.address() as AddressInfo;

  pool = new pg.Pool({ connectionString: connectionUrl(target, ROLES.api, PASSWORDS.api), max: 4 });
  app = await createApp({
    env: loadEnv({
      FS_API_PASSWORD: PASSWORDS.api,
      AUTH_SECRET: SECRET,
      SSE_BRIDGE: 'off',
      OUTBOX_RELAY: 'off',
      PIPELINE_SAMPLER: 'off',
      COLLECTOR_STATUS: 'off',
      SIM_URL: `http://127.0.0.1:${String(port)}`,
      SCENARIOS_DIR: dir,
      SCENARIO_POLL_MS: '100',
    }),
    log: createLogger('api-gateway', 'fatal'),
    clock: SystemClock,
    metrics: createMetrics(),
    pool,
    instanceId: 'test',
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  lines = app.get(LineStatusService);

  viewer = await login('viewer@fieldstream.local');
  engineer = await login('engineer@fieldstream.local');
});

afterAll(async () => {
  if (!appClosed) await app.close();
  await pool.end();
  await owner.end();
  await container.stop();
  sim.closeAllConnections();
  await new Promise<void>((resolve) => {
    sim.close(() => {
      resolve();
    });
  });
  await rm(dir, { recursive: true, force: true });
});

describe('сценарии стенда через шлюз', () => {
  it('прогон, брошенный прежним процессом, при старте шлюза завершён с ошибкой', async () => {
    const stale = await readRun(staleId);

    expect(stale).toMatchObject({
      status: 'failed',
      error: 'шлюз перезапустился посреди прогона',
    });
    expect(stale.finishedAt).not.toBeNull();
    expect(stale.steps.map((step) => step.status)).toEqual(['failed', 'skipped']);
  });

  it('наблюдатель не запускает, инженер запускает, второй запуск 409, итог passed, поломка снята', async () => {
    recorded.length = 0;
    recordBreaker('closed');

    expect((await call(viewer, 'POST', '/api/scenarios/breaker-trip/run', {})).status).toBe(403);
    expect((await call(engineer, 'POST', '/api/scenarios/meteor/run', {})).status).toBe(404);
    expect(recorded).toEqual([]);

    const run = await startRun('breaker-trip', { source: 'ci' });
    expect(run).toMatchObject({
      scenario: 'breaker-trip',
      title: 'Размыкатель на молчащем приборе',
      source: 'ci',
      requestedBy: 'engineer@fieldstream.local',
      status: 'queued',
      error: null,
    });
    expect(run.steps.map((step) => step.status)).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
    ]);

    const second = await call(engineer, 'POST', '/api/scenarios/breaker-stuck/run', {});
    expect(second.status).toBe(409);
    expect(second.json).toMatchObject({
      message:
        'на стенде идёт прогон «Размыкатель на молчащем приборе», его запустил engineer@fieldstream.local: дождитесь итога и повторите запуск',
    });

    const waiting = await waitForRun(run.id, (current) => current.steps[1]?.status === 'running');
    expect(waiting.status).toBe('running');
    expect(waiting.startedAt).not.toBeNull();
    expect(waiting.steps[0]).toMatchObject({ status: 'passed' });

    const during = scenariosResponseSchema.parse(
      (await call(viewer, 'GET', '/api/scenarios')).json,
    );
    expect(during.activeRun?.id).toBe(run.id);

    recordBreaker('open');
    await waitForRun(run.id, (current) => current.steps[3]?.status === 'running');
    recordBreaker('closed');

    const done = await waitForRun(run.id, finished);
    expect(done.status).toBe('passed');
    expect(done.error).toBeNull();
    expect(done.finishedAt).not.toBeNull();
    expect(done.steps.map((step) => step.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(done.steps[3]?.detail).toBe('RC-105: размыкатель замкнут');

    expect(recorded).toEqual([
      {
        method: 'POST',
        url: '/sim/fault',
        body: {
          targetKind: 'device',
          targetId: 'RC-105',
          kind: 'silent',
          ttlSec: 120,
          exceptionCode: 4,
        },
      },
      { method: 'DELETE', url: '/sim/faults?targetId=RC-105&kind=silent', body: null },
    ]);

    const list = await call(viewer, 'GET', '/api/scenarios');
    expect(list.status).toBe(200);
    const parsed = scenariosResponseSchema.parse(list.json);
    expect(parsed.activeRun).toBeNull();
    expect(parsed.scenarios.map((scenario) => scenario.name)).toEqual([
      'breaker-hold',
      'breaker-stuck',
      'breaker-trip',
    ]);
    const trip = parsed.scenarios.find((scenario) => scenario.name === 'breaker-trip');
    expect(trip).toMatchObject({ timeoutSec: 30, lastRun: { id: run.id, status: 'passed' } });
    expect(trip?.steps).toHaveLength(4);
    expect(
      parsed.scenarios.find((scenario) => scenario.name === 'breaker-stuck')?.lastRun,
    ).toBeNull();
  });

  it('проба не выполнилась за свой предел: итог failed, а поломка всё равно снята', async () => {
    recorded.length = 0;
    recordBreaker('closed');

    const run = await startRun('breaker-stuck');
    expect(run.source).toBe('ui');

    const done = await waitForRun(run.id, finished);
    expect(done.status).toBe('failed');
    expect(done.steps.map((step) => step.status)).toEqual(['passed', 'failed']);
    expect(done.steps[1]?.detail).toBe(
      'за 2 с не дождались, последнее: RC-105: размыкатель замкнут',
    );
    expect(done.error).toContain('шаг 2 «Дождаться, пока размыкатель RC-105 разомкнётся');
    expect(simCalls()).toEqual(['POST /sim/fault', CLEARED]);
  });

  it('неверный номер прогона 400, несуществующий 404', async () => {
    expect((await call(viewer, 'GET', '/api/scenario-runs/не-uuid')).status).toBe(400);
    expect((await call(viewer, 'GET', `/api/scenario-runs/${crypto.randomUUID()}`)).status).toBe(
      404,
    );
  });

  it('прогон другого экземпляра со свежим пульсом держит стенд, с протухшим завершается при запуске', async () => {
    recorded.length = 0;
    recordBreaker('closed');

    const foreign = await owner.query<{ id: string }>(
      `INSERT INTO core.scenario_run
         (scenario, title, source, requested_by, status, instance_id, heartbeat_at, started_at)
       VALUES ('dead-device', 'Мёртвый прибор', 'ci', 'engineer@fieldstream.local', 'running',
               'gateway-b', now(), now())
       RETURNING id`,
    );
    const foreignId = foreign.rows[0]?.id ?? '';

    expect((await call(engineer, 'POST', '/api/scenarios/breaker-stuck/run', {})).status).toBe(409);
    expect((await readRun(foreignId)).status).toBe('running');

    await owner.query(
      `UPDATE core.scenario_run SET heartbeat_at = now() - interval '5 minutes' WHERE id = $1`,
      [foreignId],
    );
    const run = await startRun('breaker-stuck');

    expect(await readRun(foreignId)).toMatchObject({
      status: 'failed',
      error: 'шлюз, исполнявший прогон, не отмечался дольше 30 с',
    });
    expect((await waitForRun(run.id, finished)).status).toBe('failed');
    expect(simCalls()).toEqual(['POST /sim/fault', CLEARED]);
  });

  it('прогон, завершённый без этого шлюза, прерывается и всё равно снимает поломку', async () => {
    recorded.length = 0;
    recordBreaker('closed');

    const run = await startRun('breaker-hold');
    await waitForRun(run.id, (current) => current.steps[1]?.status === 'running');
    await owner.query(
      `UPDATE core.scenario_run SET status = 'failed', error = 'снят вручную', finished_at = now()
       WHERE id = $1`,
      [run.id],
    );

    await waitUntil(() => simCalls().includes(CLEARED));
    expect(simCalls()).toEqual(['POST /sim/fault', CLEARED]);
    expect(await readRun(run.id)).toMatchObject({ status: 'failed', error: 'снят вручную' });
  });

  it('остановка шлюза посреди прогона не принимает запусков, завершает прогон провалом и снимает поломку', async () => {
    recorded.length = 0;
    recordBreaker('closed');

    const run = await startRun('breaker-hold');
    await waitForRun(run.id, (current) => current.steps[1]?.status === 'running');

    app.get(ScenariosService).onModuleDestroy();
    const refused = await call(engineer, 'POST', '/api/scenarios/breaker-stuck/run', {});
    expect(refused.status).toBe(503);
    expect(refused.json).toMatchObject({ message: 'шлюз останавливается, повторите запуск позже' });

    await app.close();
    appClosed = true;

    const row = await owner.query<{
      status: string;
      error: string | null;
      finished_at: Date | null;
    }>('SELECT status, error, finished_at FROM core.scenario_run WHERE id = $1', [run.id]);
    expect(row.rows[0]?.status).toBe('failed');
    expect(row.rows[0]?.error).toContain('шлюз остановлен посреди прогона');
    expect(row.rows[0]?.finished_at).not.toBeNull();
    expect(simCalls()).toEqual(['POST /sim/fault', CLEARED]);
  });
});
