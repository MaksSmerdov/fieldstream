import { afterEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { lineStatusSchema } from '@fieldstream/contracts';
import type { LineStatus, PollCycle, TelemetryRaw } from '@fieldstream/contracts';
import { DEMO_STAND } from '@fieldstream/device-profiles';
import type { RegisterSpan } from '@fieldstream/device-profiles';
import { createFakeClock } from '@fieldstream/domain';
import type { FakeClock } from '@fieldstream/domain';
import type { ModbusLink } from '../../src/transport/modbus-link.js';
import { createLineWorker } from '../../src/polling/line-worker.js';
import type { CycleReport, LineWorker } from '../../src/polling/line-worker.js';

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
  readonly statuses: LineStatus[];
  readonly requests: number[];
  readonly watchdogTrips: number[];
}

const makeWorker = (link: ModbusLink, clock: FakeClock = createFakeClock(START)): Bench => {
  const raws: TelemetryRaw[] = [];
  const cycles: PollCycle[] = [];
  const statuses: LineStatus[] = [];
  const requests: number[] = [];
  const watchdogTrips: number[] = [];
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
    publishStatus: (status) => statuses.push(status),
    onRequest: (durationMs) => requests.push(durationMs),
    onWatchdogTrip: () => watchdogTrips.push(clock.now()),
    sleep: () => Promise.resolve(),
  });
  return { worker, clock, raws, cycles, statuses, requests, watchdogTrips };
};

const timedOut = (): Error => Object.assign(new Error('Timed out'), { errno: 'ETIMEDOUT' });
const refused = (): Error =>
  Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5020'), { code: 'ECONNREFUSED' });

/** Обходы подряд, между которыми часы идут ровно на выбранную паузу. */
const runCycles = async (bench: Bench, count: number): Promise<CycleReport[]> => {
  const reports: CycleReport[] = [];
  for (let index = 0; index < count; index += 1) {
    const report = await bench.worker.runCycle();
    reports.push(report);
    bench.clock.advance(report.nextDelayMs);
  }
  return reports;
};

describe('воркер линии', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
    const { worker, cycles, statuses } = makeWorker(fakeLink().link);
    worker.setPlanMode('naive');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.planMode).toBe('naive');

    await worker.runCycle();

    expect(cycles.map((cycle) => cycle.requestCount)).toEqual([9, 9, 9, 9, 9, 9]);
    expect(cycles.every((cycle) => cycle.planMode === 'naive')).toBe(true);
  });

  it('смена такта опроса сразу уходит снимком вместе с новым лимитом сторожа', () => {
    const { worker, statuses } = makeWorker(fakeLink().link);
    worker.setPollInterval(60_000);

    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ pollIntervalMs: 60_000, watchdog: { limitMs: 360_000 } });
  });

  it('смена такта посреди обхода не меняет лимит сторожа, пока обход не закончится', async () => {
    let changeInterval = (): void => undefined;
    const fake = fakeLink((slaveId) => {
      if (slaveId === 2) changeInterval();
      return Promise.resolve();
    });
    const { worker, statuses } = makeWorker(fake.link);
    changeInterval = () => {
      changeInterval = () => undefined;
      worker.setPollInterval(120_000);
    };

    await worker.runCycle();

    expect(statuses).toHaveLength(3);
    const [begin, changed, end] = statuses;
    expect(begin).toMatchObject({
      pollIntervalMs: 10_000,
      watchdog: { limitMs: 300_000, cycleStartedAt: '2026-09-11T10:00:00.000Z' },
    });
    expect(changed).toMatchObject({
      pollIntervalMs: 120_000,
      watchdog: { limitMs: 300_000, cycleStartedAt: '2026-09-11T10:00:00.000Z' },
    });
    expect(end).toMatchObject({
      pollIntervalMs: 120_000,
      watchdog: { limitMs: 720_000, cycleStartedAt: null },
    });
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

  it('недоступный шлюз: лестница переподключения по фактам, размыкатели приборов закрыты', async () => {
    const fake = fakeLink(undefined, () => Promise.reject(refused()));
    const bench = makeWorker(fake.link);

    const reports = await runCycles(bench, 4);

    expect(bench.raws).toEqual([]);
    expect(reports.map((report) => report.outcome)).toEqual([
      'disconnected',
      'disconnected',
      'disconnected',
      'disconnected',
    ]);
    expect(reports.map((report) => report.nextDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(fake.counters.connects).toBe(4);

    expect(bench.cycles).toHaveLength(24);
    expect(bench.cycles[0]).toMatchObject({
      ok: false,
      errorKind: 'disconnected',
      requestCount: 0,
      backoff: { baseMs: 1_000, jitterMs: 0, chosenMs: 1_000 },
      breaker: { state: 'closed', nextProbeAt: null },
    });
    expect(bench.cycles.at(-1)?.backoff).toEqual({ baseMs: 8_000, jitterMs: 0, chosenMs: 8_000 });

    const status = lineStatusSchema.parse(bench.worker.status());
    expect(status.reconnects).toEqual([
      { attempt: 0, at: '2026-09-11T10:00:00.000Z', baseMs: 1_000, jitterMs: 0, chosenMs: 1_000 },
      { attempt: 1, at: '2026-09-11T10:00:01.000Z', baseMs: 2_000, jitterMs: 0, chosenMs: 2_000 },
      { attempt: 2, at: '2026-09-11T10:00:03.000Z', baseMs: 4_000, jitterMs: 0, chosenMs: 4_000 },
      { attempt: 3, at: '2026-09-11T10:00:07.000Z', baseMs: 8_000, jitterMs: 0, chosenMs: 8_000 },
    ]);
    expect(
      status.devices.every(
        (device) => device.breaker.state === 'closed' && device.breaker.failures === 0,
      ),
    ).toBe(true);
    expect(status.connected).toBe(false);
  });

  it('история переподключений хранит последние 12 попыток, пауза упирается в потолок', async () => {
    const bench = makeWorker(fakeLink(undefined, () => Promise.reject(refused())).link);

    const reports = await runCycles(bench, 14);
    const { reconnects } = bench.worker.status();

    expect(reports.at(-1)?.nextDelayMs).toBe(30_000);
    expect(reconnects).toHaveLength(12);
    expect(reconnects.map((step) => step.attempt)).toEqual(
      Array.from({ length: 12 }, (_step, index) => index + 2),
    );
  });

  it('снимок начала обхода показывает наступившую пробу как half_open', async () => {
    const fake = fakeLink((slaveId) =>
      slaveId === 1 ? Promise.reject(timedOut()) : Promise.resolve(),
    );
    const { worker, clock, statuses } = makeWorker(fake.link);

    await worker.runCycle();
    await worker.runCycle();
    clock.advance(30_000);
    statuses.splice(0);
    await worker.runCycle();

    expect(statuses).toHaveLength(2);
    const [begin, end] = statuses;
    expect(begin?.watchdog.cycleStartedAt).toBe('2026-09-11T10:00:30.000Z');
    expect(begin?.devices[0]?.breaker).toEqual({
      state: 'half_open',
      failures: 2,
      probeDelayMs: 30_000,
      nextProbeAt: '2026-09-11T10:00:30.000Z',
    });
    expect(end?.watchdog.cycleStartedAt).toBeNull();
    expect(end?.devices[0]?.breaker).toEqual({
      state: 'open',
      failures: 3,
      probeDelayMs: 60_000,
      nextProbeAt: '2026-09-11T10:01:30.000Z',
    });
  });

  it('без приборов к опросу пауза не дольше, чем до ближайшей пробы', async () => {
    const { worker, clock, statuses } = makeWorker(fakeLink(() => Promise.reject(timedOut())).link);

    await worker.runCycle();
    await worker.runCycle();

    clock.advance(10_000);
    expect(await worker.runCycle()).toMatchObject({ outcome: 'idle', nextDelayMs: 10_000 });

    clock.advance(15_000);
    statuses.splice(0);
    expect(await worker.runCycle()).toMatchObject({ outcome: 'idle', nextDelayMs: 5_000 });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      watchdog: { cycleStartedAt: null },
      lastCycle: { outcome: 'idle', durationMs: 0 },
    });

    clock.advance(5_000);
    expect((await worker.runCycle()).outcome).toBe('polled');
    expect(worker.status().latency).toMatchObject({ samples: 0, timeouts: 18 });
  });

  it('снимки в начале и в конце обхода, длительности запросов попадают в окно', async () => {
    const clock = createFakeClock(START);
    const fake = fakeLink(() => {
      clock.advance(20);
      return Promise.resolve();
    });
    const { worker, statuses, requests } = makeWorker(fake.link, clock);

    const report = await worker.runCycle();

    expect(report).toMatchObject({ outcome: 'polled', durationMs: 420 });
    expect(requests).toEqual(Array.from({ length: 21 }, () => 20));
    expect(statuses).toHaveLength(2);
    const [begin, end] = statuses.map((status) => lineStatusSchema.parse(status));
    expect(begin).toMatchObject({
      lineCode: 'L1',
      lastCycle: null,
      watchdog: { limitMs: 300_000, cycleStartedAt: '2026-09-11T10:00:00.000Z', trips: 0 },
      latency: { samples: 0 },
    });
    expect(end).toMatchObject({
      connected: true,
      requestTimeoutMs: L1.requestTimeoutMs,
      hardTimeoutMs: L1.requestTimeoutMs * 2 + 250,
      watchdog: { cycleStartedAt: null, trips: 0 },
      lastCycle: {
        at: '2026-09-11T10:00:00.420Z',
        outcome: 'polled',
        durationMs: 420,
        polled: 6,
        failed: 0,
      },
      latency: { samples: 21, timeouts: 0, p50Ms: 20, p99Ms: 20, suggestedTimeoutMs: null },
    });
    expect(end?.latency.counts[0]).toBe(21);
  });

  it('сторож цикла бросает зависший обход и отчитывается фактической длительностью', async () => {
    vi.useFakeTimers();
    const fake = fakeLink((slaveId) =>
      slaveId === 2 ? new Promise<never>(() => undefined) : Promise.resolve(),
    );
    const { worker, clock, statuses, watchdogTrips } = makeWorker(fake.link);

    const pending = worker.runCycle();
    clock.advance(300_000);
    await vi.advanceTimersByTimeAsync(300_000);
    const report = await pending;

    expect(report).toMatchObject({ outcome: 'watchdog', durationMs: 300_000 });
    expect(watchdogTrips).toEqual([START + 300_000]);
    expect(fake.counters.destroys).toBe(1);
    expect(statuses.at(-1)).toMatchObject({
      connected: false,
      watchdog: { cycleStartedAt: null, trips: 1 },
      lastCycle: { outcome: 'watchdog', durationMs: 300_000, polled: 0 },
    });
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
    const { worker, cycles, statuses } = makeWorker(fake.link);

    worker.start();
    await worker.stop();

    expect(cycles.length).toBeGreaterThanOrEqual(6);
    expect(worker.snapshot().connected).toBe(false);
    expect(statuses.at(-1)).toMatchObject({
      running: false,
      connected: false,
      watchdog: { cycleStartedAt: null },
    });
  });

  /**
   * Команда остановки и следующая за ней команда запуска приходят из брокера подряд.
   * Остановка не должна закрыть порт уже нового цикла: линия иначе замолчит навсегда,
   * причём исполнитель ответит «применено».
   */
  it('запуск сразу после остановки не оставляет линию мёртвой', async () => {
    const fake = fakeLink();
    const { worker, cycles } = makeWorker(fake.link);

    worker.start();
    const stopped = worker.stop();
    worker.start();
    await stopped;

    expect(worker.isRunning()).toBe(true);
    expect(worker.snapshot().connected).toBe(true);
    expect(cycles.length).toBeGreaterThan(0);

    await worker.stop();
    expect(worker.isRunning()).toBe(false);
    expect(worker.snapshot().connected).toBe(false);
  });

  it('повторная остановка не закрывает порт второй раз', async () => {
    const fake = fakeLink();
    const { worker } = makeWorker(fake.link);

    worker.start();
    await Promise.all([worker.stop(), worker.stop()]);

    expect(fake.counters.destroys).toBe(1);
  });
});
