import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ModuleId } from '@fieldstream/contracts';
import { createFakeClock } from '@fieldstream/domain';
import { createLogger } from '@fieldstream/nest-common';
import { deriveKeys, issueAccessToken } from '../src/auth/tokens.js';
import { createApp } from '../src/bootstrap.js';
import { loadEnv } from '../src/config/env.js';
import { LiveBusService } from '../src/events/live-bus.service.js';
import { createMetrics } from '../src/metrics/metrics.js';

const SECRET = 'секрет стенда длиной не меньше тридцати двух символов';
const clock = createFakeClock(1_770_000_000_000);
const pool = { query: () => Promise.resolve({ rows: [] }) } as unknown as pg.Pool;

let app: NestFastifyApplication;
let bus: LiveBusService;
let base: string;

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

interface Frame {
  readonly type: string;
  readonly id: string | null;
  readonly data: Record<string, unknown>;
}

const parseFrame = (raw: string): Frame => {
  let type = 'message';
  let id: string | null = null;
  let data = '{}';

  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) type = line.slice(7);
    if (line.startsWith('id: ')) id = line.slice(4);
    if (line.startsWith('data: ')) data = line.slice(6);
  }

  return { type, id, data: JSON.parse(data) as Record<string, unknown> };
};

/** Соединение с живым каналом, из которого кадры читаются по одному. */
const open = async (
  token: string,
  options: { query?: string; lastEventId?: string } = {},
): Promise<{ next: () => Promise<Frame>; close: () => void }> => {
  const abort = new AbortController();
  const response = await fetch(`${base}/api/events${options.query ?? ''}`, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.lastEventId === undefined ? {} : { 'last-event-id': options.lastEventId }),
    },
    signal: abort.signal,
  });
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (body === null) throw new Error('поток не открылся');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const next = async (): Promise<Frame> => {
    for (;;) {
      const separator = buffer.indexOf('\n\n');
      if (separator >= 0) {
        const raw = buffer.slice(0, separator).trim();
        buffer = buffer.slice(separator + 2);
        if (raw.length > 0) return parseFrame(raw);
        continue;
      }

      const chunk = await reader.read();
      if (chunk.done) throw new Error('поток закрылся');
      buffer += decoder.decode(chunk.value);
    }
  };

  return {
    next,
    close: () => {
      abort.abort();
    },
  };
};

beforeAll(async () => {
  app = await createApp({
    env: loadEnv({
      FS_API_PASSWORD: 'тест',
      AUTH_SECRET: SECRET,
      SSE_BRIDGE: 'off',
      SSE_PING_MS: '60000',
      SSE_RING_SIZE: '100',
    }),
    log: createLogger('api-gateway', 'fatal'),
    clock,
    metrics: createMetrics(),
    pool,
    instanceId: 'test',
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  bus = app.get(LiveBusService);
});

afterAll(async () => {
  await app.close();
});

describe('живой канал', () => {
  it('здоровается эпохой и серверным временем, потом шлёт события', async () => {
    const stream = await open(await tokenFor(['devices']));

    const hello = await stream.next();
    expect(hello.type).toBe('hello');
    expect(hello.data['epoch']).toBe(bus.epoch());
    expect(hello.id?.startsWith(`${String(bus.epoch())}:`)).toBe(true);

    bus.publish('device-state', ['device:RC-101'], { deviceCode: 'RC-101', status: 'online' });
    const event = await stream.next();

    expect(event.type).toBe('device-state');
    expect(event.id).toMatch(/^\d+:\d+$/);
    expect(event.data['deviceCode']).toBe('RC-101');

    stream.close();
  });

  /** Вкладка теряет соединение и возвращается: пропущенное должно прийти, а не исчезнуть. */
  it('вернувшийся сразу после приветствия не теряет ничего: позиция уже в его идентификаторе', async () => {
    const token = await tokenFor(['devices']);
    const first = await open(token);
    const hello = await first.next();
    first.close();

    bus.publish('device-state', ['device:RC-101'], { step: 'после приветствия' });

    const second = await open(token, { lastEventId: hello.id ?? '' });
    expect((await second.next()).type).toBe('hello');
    expect((await second.next()).data['step']).toBe('после приветствия');

    second.close();
  });

  it('досылает пропущенное по последнему полученному идентификатору', async () => {
    const token = await tokenFor(['devices']);
    const first = await open(token);
    await first.next();

    bus.publish('device-state', ['device:RC-101'], { step: 1 });
    const seen = await first.next();
    first.close();

    bus.publish('device-state', ['device:RC-101'], { step: 2 });
    bus.publish('device-state', ['device:RC-101'], { step: 3 });

    const second = await open(token, { lastEventId: seen.id ?? '' });
    expect((await second.next()).type).toBe('hello');
    expect((await second.next()).data['step']).toBe(2);
    expect((await second.next()).data['step']).toBe(3);

    second.close();
  });

  it('идентификатор чужой эпохи просит перечитать всё, а не молчит', async () => {
    const stream = await open(await tokenFor(['devices']), { lastEventId: '1:1' });

    expect((await stream.next()).type).toBe('hello');
    const resync = await stream.next();
    expect(resync.type).toBe('resync');
    expect(resync.data['reason']).toBe('unknown_epoch');

    stream.close();
  });

  it('события приборов не уходят тому, у кого нет права на приборы', async () => {
    const stream = await open(await tokenFor(['overview']));
    await stream.next();

    bus.publish('device-state', ['device:RC-101'], { deviceCode: 'RC-101' });
    bus.publish('ping', [], { at: 'сейчас' });

    expect((await stream.next()).type).toBe('ping');

    stream.close();
  });

  it('подписка на прибор отсекает чужие события', async () => {
    const stream = await open(await tokenFor(['devices']), { query: '?devices=RC-101' });
    await stream.next();

    bus.publish('device-state', ['device:RC-102'], { deviceCode: 'RC-102' });
    bus.publish('device-state', ['device:RC-101'], { deviceCode: 'RC-101' });

    const event = await stream.next();
    expect(event.data['deviceCode']).toBe('RC-101');

    stream.close();
  });
});
