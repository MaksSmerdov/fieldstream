import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeClock, toIsoTimestamp } from '@fieldstream/domain';
import { createLogger } from '@fieldstream/nest-common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../src/bootstrap.js';
import { loadEnv } from '../src/config/env.js';
import { createMetrics } from '../src/metrics/metrics.js';

const clock = createFakeClock(1_760_000_000_000);
const pool = { query: () => Promise.resolve({ rows: [] }) } as unknown as pg.Pool;

let app: NestFastifyApplication;
let base: string;

beforeAll(async () => {
  app = await createApp({
    env: loadEnv({ FS_API_PASSWORD: 'тест', SSE_PING_MS: '1000' }),
    log: createLogger('api-gateway', 'fatal'),
    clock,
    metrics: createMetrics(),
    pool,
    instanceId: 'test',
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

describe('шлюз отдаёт серверное время', () => {
  it('в обычном ответе', async () => {
    const response = await fetch(`${base}/health/live`);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-server-time')).toBe(toIsoTimestamp(clock.now()));
  });

  /**
   * Живой канал пишет прямо в сокет и снимает заголовки один раз, до первого события.
   * Заголовок, поставленный интерсептором, туда уже не попадает, поэтому проверка отдельная.
   */
  it('в живом канале, где заголовки уходят до первого события', async () => {
    const abort = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: abort.signal });

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.headers.get('x-server-time')).toBe(toIsoTimestamp(clock.now()));

    const body = response.body as ReadableStream<Uint8Array> | null;
    const first = await body!.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain('event: hello');

    abort.abort();
  });

  it('маршруты обслуживания живут вне префикса, прикладные внутри', async () => {
    expect((await fetch(`${base}/metrics`)).status).toBe(200);
    expect((await fetch(`${base}/api/metrics`)).status).toBe(404);
    expect((await fetch(`${base}/events`)).status).toBe(404);
  });
});
