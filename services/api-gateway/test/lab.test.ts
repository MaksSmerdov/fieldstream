import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ROLE_MODULES,
  labFaultsResponseSchema,
  labLinesResponseSchema,
  simFaultSchema,
} from '@fieldstream/contracts';
import type { LineStatus, ModuleId, SimFault, SimState } from '@fieldstream/contracts';
import { SystemClock, createFakeClock, toIsoTimestamp } from '@fieldstream/domain';
import { createLogger } from '@fieldstream/nest-common';
import { deriveKeys, issueAccessToken } from '../src/auth/tokens.js';
import { createApp } from '../src/bootstrap.js';
import { loadEnv } from '../src/config/env.js';
import { LineStatusService } from '../src/lab/line-status.service.js';
import { createMetrics } from '../src/metrics/metrics.js';

const SECRET = 'секрет стенда длиной не меньше тридцати двух символов';
const clock = createFakeClock(1_770_000_000_000);
const TS = toIsoTimestamp(clock.now());
const pool = { query: () => Promise.resolve({ rows: [] }) } as unknown as pg.Pool;

const FAULT: SimFault = {
  id: 'fault-1',
  targetKind: 'line',
  targetId: 'L1',
  kind: 'offline',
  since: TS,
  expiresAt: toIsoTimestamp(clock.now() + 60_000),
  exceptionCode: null,
  paramKey: null,
};

const STATE: SimState = {
  simTime: TS,
  speed: 1,
  seed: 'стенд',
  lines: [],
  devices: [],
  faults: [FAULT],
};

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

interface Canned {
  readonly status: number;
  readonly body: unknown;
  readonly problem?: boolean;
  readonly hang?: boolean;
}

const recorded: Recorded[] = [];
const canned = new Map<string, Canned>();

let sim: Server;
let simRunning = true;
let app: NestFastifyApplication;
let base: string;
let viewer: string;
let engineer: string;

/** Поддельный стенд: записывает запросы и отвечает заготовкой по методу и пути, зависшая не отвечает. */
const handle = (request: IncomingMessage, response: ServerResponse): void => {
  let raw = '';
  request.on('data', (chunk: Buffer) => {
    raw += chunk.toString('utf8');
  });
  request.on('end', () => {
    const method = request.method ?? '';
    const url = request.url ?? '';
    recorded.push({ method, url, body: raw.length > 0 ? (JSON.parse(raw) as unknown) : null });

    const reply = canned.get(`${method} ${url.split('?')[0] ?? ''}`) ?? {
      status: 404,
      problem: true,
      body: { type: 'about:blank', title: 'Нет маршрута', status: 404, detail: 'нет маршрута' },
    };
    if (reply.hang === true) return;

    response.writeHead(reply.status, {
      'content-type': reply.problem === true ? 'application/problem+json' : 'application/json',
    });
    response.end(JSON.stringify(reply.body));
  });
};

const tokenFor = async (permissions: readonly ModuleId[]): Promise<string> =>
  (
    await issueAccessToken(
      deriveKeys(SECRET),
      {
        userId: 'ba0ba102-a143-4f6c-8538-47bded9939fb',
        email: 'engineer@fieldstream.local',
        sessionId: 'сессия',
        role: 'engineer',
        permissions,
      },
      clock.now(),
      600_000,
    )
  ).token;

const call = async (
  token: string,
  method: 'GET' | 'POST' | 'DELETE',
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

/** Снимок линии с заданным моментом и признаком связи. */
const statusOf = (lineCode: string, ts: string, connected: boolean): LineStatus => ({
  schema: 'line.status',
  v: 1,
  ts,
  lineCode,
  running: true,
  connected,
  planMode: 'merged',
  pollIntervalMs: 10_000,
  requestTimeoutMs: 600,
  hardTimeoutMs: 1_450,
  watchdog: { limitMs: 300_000, cycleStartedAt: null, trips: 0 },
  lastCycle: { at: ts, outcome: 'polled', durationMs: 420, polled: 6, failed: 0 },
  reconnects: [],
  devices: [
    {
      deviceCode: 'RC-101',
      slaveId: 1,
      breaker: { state: 'closed', failures: 0, probeDelayMs: 0, nextProbeAt: null },
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
});

/** Приложение шлюза без фоновых опросов; без адреса стенда раздел поломок не подключён. */
const startApp = async (simUrl?: string): Promise<NestFastifyApplication> => {
  const started = await createApp({
    env: loadEnv({
      FS_API_PASSWORD: 'тест',
      AUTH_SECRET: SECRET,
      SSE_BRIDGE: 'off',
      OUTBOX_RELAY: 'off',
      COLLECTOR_STATUS: 'off',
      PIPELINE_SAMPLER: 'off',
      ...(simUrl === undefined ? {} : { SIM_URL: simUrl }),
    }),
    log: createLogger('api-gateway', 'fatal'),
    clock,
    metrics: createMetrics(),
    pool,
    instanceId: 'test',
  });
  await started.listen(0, '127.0.0.1');
  return started;
};

beforeAll(async () => {
  sim = createServer(handle);
  await new Promise<void>((resolve) => {
    sim.listen(0, '127.0.0.1', resolve);
  });
  const { port } = sim.address() as AddressInfo;

  app = await startApp(`http://127.0.0.1:${String(port)}`);
  base = await app.getUrl();

  viewer = await tokenFor(ROLE_MODULES.viewer);
  engineer = await tokenFor(ROLE_MODULES.engineer);
});

afterAll(async () => {
  await app.close();
  if (simRunning) {
    sim.closeAllConnections();
    await new Promise<void>((resolve) => {
      sim.close(() => {
        resolve();
      });
    });
  }
});

beforeEach(() => {
  recorded.length = 0;
  canned.clear();
  canned.set('GET /sim/state', { status: 200, body: STATE });
  canned.set('POST /sim/fault', { status: 201, body: FAULT });
  canned.set('DELETE /sim/faults', { status: 200, body: { removed: 2 } });
});

describe('поломки стенда через шлюз', () => {
  it('наблюдатель видит поломки, но вносить и снимать их не может', async () => {
    const list = await call(viewer, 'GET', '/api/lab/faults');
    expect(list.status).toBe(200);
    expect(labFaultsResponseSchema.parse(list.json).faults).toEqual([FAULT]);

    const inject = await call(viewer, 'POST', '/api/lab/faults', {
      targetKind: 'line',
      targetId: 'L1',
      kind: 'offline',
    });
    expect(inject.status).toBe(403);
    expect((await call(viewer, 'DELETE', '/api/lab/faults')).status).toBe(403);

    expect(recorded.map((request) => request.method)).toEqual(['GET']);
  });

  it('инженер вносит поломку: описание доходит до стенда, ответ 201 с поломкой', async () => {
    const { status, json } = await call(engineer, 'POST', '/api/lab/faults', {
      targetKind: 'line',
      targetId: 'L1',
      kind: 'offline',
      ttlSec: 60,
    });

    expect(status).toBe(201);
    expect(simFaultSchema.parse(json)).toEqual(FAULT);
    expect(recorded).toEqual([
      {
        method: 'POST',
        url: '/sim/fault',
        body: { targetKind: 'line', targetId: 'L1', kind: 'offline', ttlSec: 60, exceptionCode: 4 },
      },
    ]);
  });

  it('отказ стенда 422 возвращается тем же кодом и его текстом', async () => {
    canned.set('POST /sim/fault', {
      status: 422,
      problem: true,
      body: {
        type: 'about:blank',
        title: 'Поломка неприменима',
        status: 422,
        detail: 'у прибора RC-101 нет параметра flow_m3h',
      },
    });

    const { status, json } = await call(engineer, 'POST', '/api/lab/faults', {
      targetKind: 'device',
      targetId: 'RC-101',
      kind: 'offscale',
      paramKey: 'flow_m3h',
    });

    expect(status).toBe(422);
    expect(json).toMatchObject({ message: 'у прибора RC-101 нет параметра flow_m3h' });
  });

  it('неверное описание отвергается шлюзом и до стенда не доходит', async () => {
    const defrost = await call(engineer, 'POST', '/api/lab/faults', {
      targetKind: 'device',
      targetId: 'RC-101',
      kind: 'defrost',
    });
    const wrongTarget = await call(engineer, 'POST', '/api/lab/faults', {
      targetKind: 'line',
      targetId: 'RC-101',
      kind: 'offline',
    });

    expect(defrost.status).toBe(400);
    expect(wrongTarget.status).toBe(400);
    expect(recorded).toEqual([]);
  });

  it('фильтры снятия доходят до стенда, неверный фильтр до него не доходит', async () => {
    const { status, json } = await call(
      engineer,
      'DELETE',
      '/api/lab/faults?targetId=L2&kind=offline',
    );

    expect(status).toBe(200);
    expect(json).toEqual({ removed: 2 });
    expect(recorded).toEqual([
      { method: 'DELETE', url: '/sim/faults?targetId=L2&kind=offline', body: null },
    ]);

    expect((await call(engineer, 'DELETE', '/api/lab/faults?kind=мусор')).status).toBe(400);
    expect(recorded).toHaveLength(1);
  });

  it('ответ стенда не по контракту это 502', async () => {
    canned.set('GET /sim/state', { status: 200, body: { faults: 'не список' } });

    expect((await call(viewer, 'GET', '/api/lab/faults')).status).toBe(502);
  });

  it('зависший стенд обрывается по таймауту: 503, а не вечное ожидание', async () => {
    canned.set('GET /sim/state', { status: 200, body: STATE, hang: true });
    const startedAt = SystemClock.now();

    const { status, json } = await call(viewer, 'GET', '/api/lab/faults');
    const elapsed = SystemClock.now() - startedAt;

    expect(status).toBe(503);
    expect(json).toMatchObject({ message: 'симулятор недоступен' });
    expect(recorded.map((request) => request.url)).toEqual(['/sim/state']);
    expect(elapsed).toBeGreaterThanOrEqual(2_500);
    expect(elapsed).toBeLessThan(8_000);
  }, 15_000);
});

describe('стенд не подключён к шлюзу', () => {
  let detached: NestFastifyApplication;
  let detachedBase: string;

  beforeAll(async () => {
    detached = await startApp();
    detachedBase = await detached.getUrl();
  });

  afterAll(async () => {
    await detached.close();
  });

  it('без SIM_URL раздел поломок отвечает 503 с понятным текстом', async () => {
    const list = await fetch(`${detachedBase}/api/lab/faults`, {
      headers: { authorization: `Bearer ${viewer}` },
    });
    const clear = await fetch(`${detachedBase}/api/lab/faults`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${engineer}` },
    });

    expect(list.status).toBe(503);
    expect(await list.json()).toMatchObject({ message: 'симулятор не подключён к шлюзу' });
    expect(clear.status).toBe(503);
  });
});

describe('статус линий', () => {
  it('отдаёт последние снимки по порядку кодов, старый снимок новый не затирает', async () => {
    const service = app.get(LineStatusService);
    const later = toIsoTimestamp(clock.now() + 10_000);

    service.record(statusOf('L2', TS, true));
    service.record(statusOf('L1', later, true));
    service.record(statusOf('L1', TS, false));

    const { status, json } = await call(viewer, 'GET', '/api/lab/lines');
    const parsed = labLinesResponseSchema.parse(json);

    expect(status).toBe(200);
    expect(parsed.lines.map((line) => [line.lineCode, line.ts, line.connected])).toEqual([
      ['L1', later, true],
      ['L2', TS, true],
    ]);
  });
});

describe('стенд выключен', () => {
  it('отвергнутое соединение со стендом это 503', async () => {
    simRunning = false;
    sim.closeAllConnections();
    await new Promise<void>((resolve) => {
      sim.close(() => {
        resolve();
      });
    });

    const { status, json } = await call(viewer, 'GET', '/api/lab/faults');

    expect(status).toBe(503);
    expect(json).toMatchObject({ message: 'симулятор недоступен' });
  });
});
