import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { PollCycle, TelemetryRaw } from '@fieldstream/contracts';
import { DEMO_STAND } from '@fieldstream/device-profiles';
import type { RegisterSpan } from '@fieldstream/device-profiles';
import { createFakeClock } from '@fieldstream/domain';
import type { FakeClock } from '@fieldstream/domain';
import type { ModbusLink } from '../transport/modbus-link.js';
import { createLineWorker } from './line-worker.js';
import type { LineWorker } from './line-worker.js';

const L1 = DEMO_STAND.lines.find((line) => line.code === 'L1');
if (L1 === undefined) throw new Error('на стенде нет линии L1');

const START = Date.parse('2026-09-11T10:00:00Z');

interface FakeLink {
  readonly link: ModbusLink;
  readonly asked: { slaveId: number; span: RegisterSpan }[];
  readonly counters: { connects: number; destroys: number };
}

/** Порт линии без сети: поведение чтения и подключения задаёт тест. */
const fakeLink = (
  read: (slaveId: number) => Promise<void> = () => Promise.resolve(),
  connect: () => Promise<void> = () => Promise.resolve(),
): FakeLink => {
  let open = false;
  const asked: FakeLink['asked'] = [];
  const counters = { connects: 0, destroys: 0 };

  return {
    asked,
    counters,
    link: {
      isOpen: () => open,
      connect: async () => {
        counters.connects += 1;
        await connect();
        open = true;
      },
      read: async (slaveId, span) => {
        asked.push({ slaveId, span });
        await read(slaveId);
        return Array.from({ length: span.registerCount }, () => 0);
      },
      destroy: () => {
        counters.destroys += 1;
        open = false;
      },
    },
  };
};

interface Bench {
  readonly worker: LineWorker;
  readonly clock: FakeClock;
  readonly raws: TelemetryRaw[];
  readonly cycles: PollCycle[];
}

const makeWorker = (link: ModbusLink): Bench => {
  const clock = createFakeClock(START);
  const raws: TelemetryRaw[] = [];
  const cycles: PollCycle[] = [];
  const worker = createLineWorker({
    stand: DEMO_STAND,
    line: L1,
    host: '127.0.0.1',
    link,
    clock,
    random: () => 0.5,
    log: pino({ enabled: false }),
    publishRaw: (frame) => raws.push(frame),
    publishCycle: (cycle) => cycles.push(cycle),
    sleep: () => Promise.resolve(),
  });
  return { worker, clock, raws, cycles };
};

const timedOut = (): Error => Object.assign(new Error('Timed out'), { errno: 'ETIMEDOUT' });
const refused = (): Error =>
  Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5020'), { code: 'ECONNREFUSED' });

describe('воркер линии', () => {
  it('обход даёт кадр и событие на каждый прибор, один traceId на весь обход', async () => {
    const { worker, raws, cycles } = makeWorker(fakeLink().link);
    const report = await worker.runCycle();

    expect(report).toMatchObject({ outcome: 'polled', polled: 6, failed: 0, nextDelayMs: 10_000 });
    expect(raws.map((frame) => frame.deviceCode)).toEqual([
      'RC-101',
      'RC-102',
      'RC-103',
      'PM-201',
      'PM-202',
      'PM-203',
    ]);
    expect(new Set([...raws, ...cycles].map((message) => message.traceId)).size).toBe(1);
    expect(cycles.map((cycle) => cycle.requestCount)).toEqual([4, 4, 4, 3, 3, 3]);
    expect(cycles.every((cycle) => cycle.ok && cycle.breaker?.state === 'closed')).toBe(true);
  });

  it('в режиме naive на каждый параметр уходит свой запрос', async () => {
    const { worker, cycles } = makeWorker(fakeLink().link);
    worker.setPlanMode('naive');
    await worker.runCycle();

    expect(cycles.map((cycle) => cycle.requestCount)).toEqual([9, 9, 9, 9, 9, 9]);
    expect(cycles.every((cycle) => cycle.planMode === 'naive')).toBe(true);
  });

  it('молчащий прибор после двух отказов выпадает из обхода до пробы', async () => {
    const fake = fakeLink((slaveId) =>
      slaveId === 1 ? Promise.reject(timedOut()) : Promise.resolve(),
    );
    const { worker, clock, cycles } = makeWorker(fake.link);
    const askedSlaveOne = (): number =>
      fake.asked.filter((request) => request.slaveId === 1).length;

    await worker.runCycle();
    await worker.runCycle();
    expect(askedSlaveOne()).toBe(2);
    expect(cycles.filter((cycle) => cycle.deviceCode === 'RC-101').at(-1)?.breaker?.state).toBe(
      'open',
    );

    clock.advance(10_000);
    await worker.runCycle();
    expect(askedSlaveOne()).toBe(2);

    clock.advance(20_000);
    await worker.runCycle();
    expect(askedSlaveOne()).toBe(3);
    expect(worker.snapshot().devices[0]).toMatchObject({ breaker: 'open', failures: 3 });
  });

  it('недоступный шлюз: события обрыва с фактической задержкой и никаких кадров', async () => {
    const fake = fakeLink(undefined, () => Promise.reject(refused()));
    const { worker, raws, cycles } = makeWorker(fake.link);

    const first = await worker.runCycle();
    const second = await worker.runCycle();

    expect(raws).toEqual([]);
    expect(first).toMatchObject({ outcome: 'disconnected', nextDelayMs: 1_000 });
    expect(second).toMatchObject({ outcome: 'disconnected', nextDelayMs: 2_000 });
    expect(cycles).toHaveLength(12);
    expect(cycles[0]).toMatchObject({
      ok: false,
      errorKind: 'disconnected',
      requestCount: 0,
      backoff: { baseMs: 1_000, jitterMs: 0, chosenMs: 1_000 },
    });

    const third = await worker.runCycle();
    expect(third.outcome).toBe('idle');
    expect(fake.counters.connects).toBe(2);
  });

  it('после обрыва посреди обхода соединение пересоздаётся для следующего прибора', async () => {
    const fake = fakeLink((slaveId) =>
      slaveId === 2
        ? Promise.reject(Object.assign(new Error('Port Not Open'), { errno: 'ECONNREFUSED' }))
        : Promise.resolve(),
    );
    const { worker, raws, cycles } = makeWorker(fake.link);
    await worker.runCycle();

    expect(fake.counters.connects).toBe(2);
    expect(fake.counters.destroys).toBe(1);
    expect(raws).toHaveLength(5);
    expect(cycles.find((cycle) => cycle.deviceCode === 'RC-102')?.errorKind).toBe('disconnected');
  });

  it('цикл запускается и штатно останавливается', async () => {
    const fake = fakeLink();
    const { worker, cycles } = makeWorker(fake.link);

    worker.start();
    await worker.stop();

    expect(cycles.length).toBeGreaterThanOrEqual(6);
    expect(worker.snapshot().connected).toBe(false);
  });
});
