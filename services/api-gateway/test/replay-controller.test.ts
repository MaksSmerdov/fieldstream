import type pg from 'pg';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLE_MODULES } from '@fieldstream/contracts';
import type { ModuleId } from '@fieldstream/contracts';
import { createFakeClock, toIsoTimestamp } from '@fieldstream/domain';
import { createLogger } from '@fieldstream/nest-common';
import { deriveKeys, issueAccessToken } from '../src/auth/tokens.js';
import { createApp } from '../src/bootstrap.js';
import { loadEnv } from '../src/config/env.js';
import { createMetrics } from '../src/metrics/metrics.js';

const SECRET = 'секрет стенда длиной не меньше тридцати двух символов';
const HOUR_MS = 3_600_000;
const RUN_ID = 'ba0ba102-a143-4f6c-8538-47bded9939fb';
const clock = createFakeClock(1_770_000_000_000);

/** База недоступна: топология не читается, а до запросов прогона дело не доходит. */
const pool = {
  query: () => Promise.reject(new Error('база недоступна')),
  connect: () => Promise.reject(new Error('база недоступна')),
} as unknown as pg.Pool;

let app: NestFastifyApplication;
let base: string;
let viewer: string;
let engineer: string;

const tokenFor = async (permissions: readonly ModuleId[]): Promise<string> =>
  (
    await issueAccessToken(
      deriveKeys(SECRET),
      {
        userId: RUN_ID,
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

/** Запрос перепрогона за последний час по камере с примером правки. */
const requestOf = (fields: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  from: toIsoTimestamp(clock.now() - HOUR_MS),
  to: toIsoTimestamp(clock.now()),
  deviceCodes: ['RC-101'],
  patches: [{ metricKey: 'evap_temp_c', mode: 'defrost', maxValue: 8 }],
  ...fields,
});

beforeAll(async () => {
  app = await createApp({
    env: loadEnv({
      FS_API_PASSWORD: 'тест',
      AUTH_SECRET: SECRET,
      SSE_BRIDGE: 'off',
      OUTBOX_RELAY: 'off',
      COLLECTOR_STATUS: 'off',
      PIPELINE_SAMPLER: 'off',
    }),
    log: createLogger('api-gateway', 'fatal'),
    clock,
    metrics: createMetrics(),
    pool,
    instanceId: 'test',
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  viewer = await tokenFor(ROLE_MODULES.viewer);
  engineer = await tokenFor(ROLE_MODULES.engineer);
});

afterAll(async () => {
  await app.close();
});

describe('перепрогон без базы и топологии', () => {
  it('пока топология не прочитана, запуск отвечает 503 с понятным текстом', async () => {
    const { status, json } = await call(engineer, 'POST', '/api/replay-runs', requestOf());

    expect(status).toBe(503);
    expect(json).toMatchObject({
      message: 'топология стенда ещё не прочитана, повторите запуск позже',
    });
  });

  it('наблюдатель запустить перепрогон не может', async () => {
    expect((await call(viewer, 'POST', '/api/replay-runs', requestOf())).status).toBe(403);
  });

  it('стандартные проверки запроса и строки эпизодов отвечают по-русски и называют поле', async () => {
    const start = await call(engineer, 'POST', '/api/replay-runs', requestOf({ from: undefined }));
    expect(start.status).toBe(400);
    expect(start.json).toMatchObject({ message: ['from: обязательное поле'] });

    const episodes = await call(
      viewer,
      'GET',
      `/api/replay-runs/${RUN_ID}/episodes?metricKey=evap_temp_c&mode=heating`,
    );
    expect(episodes.status).toBe(400);
    expect(episodes.json).toMatchObject({
      message: ['deviceCode: обязательное поле', 'mode: допустимо cooling, defrost, service, off'],
    });
  });
});
