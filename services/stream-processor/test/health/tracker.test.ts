import { describe, expect, it } from 'vitest';
import { DEFAULT_HEALTH_POLICY } from '@fieldstream/contracts';
import type { DeviceEvent, DeviceState, PollCycle } from '@fieldstream/contracts';
import { DEMO_STAND } from '@fieldstream/device-profiles';
import { createFakeClock } from '@fieldstream/domain';
import type { FakeClock } from '@fieldstream/domain';
import { createHealthTracker } from '../../src/health/tracker.js';
import type { HealthTracker } from '../../src/health/tracker.js';
import type { FrameObservation } from '../../src/ingest/frame.js';

const START = Date.parse('2026-09-11T10:00:00Z');
const HOUR_AGO = START - 3_600_000;
const ALL = DEMO_STAND.devices.map((device) => device.code);

const iso = (atMs: number): string => new Date(atMs).toISOString();

/** Трекер без приборов: так он выглядит до первого вступления в группу. */
const bare = (): { clock: FakeClock; tracker: HealthTracker } => {
  const clock = createFakeClock(START);
  return {
    clock,
    tracker: createHealthTracker({ stand: DEMO_STAND, clock, policy: DEFAULT_HEALTH_POLICY }),
  };
};

/** Трекер, которому достались все приборы стенда без записанного состояния. */
const make = (): { clock: FakeClock; tracker: HealthTracker } => {
  const made = bare();
  made.tracker.adopt(ALL, []);
  return made;
};

const cycle = (deviceCode: string, ok: boolean, atMs: number): PollCycle => ({
  schema: 'poll.cycle',
  v: 1,
  ts: iso(atMs),
  lineCode: 'L1',
  deviceCode,
  ok,
  errorKind: ok ? null : 'timeout',
  durationMs: 40,
  requestCount: 4,
  planMode: 'merged',
  traceId: '0123456789abcdef',
});

const door = (deviceCode: string, atMs: number, doorOpen: boolean): FrameObservation => ({
  deviceCode,
  atMs,
  mode: 'cooling',
  doorOpen,
  defrostActive: false,
});

const doorOpened = (atMs: number): DeviceEvent => ({
  deviceCode: 'RC-102',
  kind: 'door_opened',
  occurredAt: iso(atMs),
  payload: {},
});

/** Состояние, записанное прежним владельцем прибора час назад. */
const recorded = (deviceCode: string, overrides: Partial<DeviceState> = {}): DeviceState => ({
  schema: 'device.state',
  v: 1,
  deviceCode,
  status: 'online',
  reason: 'ok',
  since: iso(HOUR_AGO),
  mode: 'cooling',
  lastOkAt: iso(HOUR_AGO),
  consecutiveErrors: 0,
  ...overrides,
});

const stateOf = (tracker: HealthTracker, code: string): unknown =>
  tracker.evaluate().states.find((state) => state.deviceCode === code);

describe('трекер здоровья', () => {
  it('сразу после старта все приборы ждут первого опроса, а состояние уходит один раз', () => {
    const { tracker } = make();
    const first = tracker.evaluate().states;

    expect(first).toHaveLength(24);
    expect(
      first.every((state) => state.status === 'unknown' && state.reason === 'startup_grace'),
    ).toBe(true);

    tracker.confirmPublished(first);
    expect(tracker.evaluate().states).toEqual([]);
  });

  it('пока публикация не подтверждена, то же состояние предлагается снова', () => {
    const { tracker } = make();

    expect(tracker.evaluate().states).toHaveLength(24);
    expect(tracker.evaluate().states).toHaveLength(24);
  });

  it('успешный цикл делает прибор online, пять отказов подряд уводят в offline с событием', () => {
    const { clock, tracker } = make();
    tracker.confirmPublished(tracker.evaluate().states);

    tracker.observeCycle(cycle('RC-101', true, START + 1_000));
    clock.advance(2_000);
    expect(stateOf(tracker, 'RC-101')).toMatchObject({ status: 'online', reason: 'ok' });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      tracker.observeCycle(cycle('RC-101', false, START + 10_000 * (attempt + 1)));
    }
    clock.advance(60_000);
    const evaluation = tracker.evaluate();

    expect(evaluation.states.find((state) => state.deviceCode === 'RC-101')).toMatchObject({
      status: 'offline',
      reason: 'consecutive_errors',
      consecutiveErrors: 5,
    });
    expect(evaluation.events).toContainEqual(
      expect.objectContaining({ deviceCode: 'RC-101', kind: 'went_offline' }),
    );
  });

  it('дверь из кадров даёт событие с моментом кадра, а не проверки', () => {
    const { tracker } = make();
    const draft = tracker.draftFrames();

    expect(draft.observe(door('RC-102', START + 1_000, false))).toEqual([]);
    expect(draft.observe(door('RC-102', START + 11_000, true))).toEqual([
      doorOpened(START + 11_000),
    ]);
  });

  it('незаписанная пачка не сдвигает снимок: повтор тех же кадров даёт те же события', () => {
    const { tracker } = make();
    const baseline = tracker.draftFrames();
    baseline.observe(door('RC-102', START + 1_000, false));
    baseline.commit();

    const failed = tracker.draftFrames();
    expect(failed.observe(door('RC-102', START + 11_000, true))).toEqual([
      doorOpened(START + 11_000),
    ]);

    const retry = tracker.draftFrames();
    expect(retry.observe(door('RC-102', START + 11_000, true))).toEqual([
      doorOpened(START + 11_000),
    ]);
    retry.commit();

    expect(tracker.draftFrames().observe(door('RC-102', START + 21_000, true))).toEqual([]);
  });

  it('смена режима публикует новое состояние только этого прибора и только после записи', () => {
    const { tracker } = make();
    tracker.confirmPublished(tracker.evaluate().states);

    const draft = tracker.draftFrames();
    draft.observe({
      deviceCode: 'RC-103',
      atMs: START + 5_000,
      mode: 'defrost',
      doorOpen: false,
      defrostActive: true,
    });
    expect(tracker.evaluate().states).toEqual([]);

    draft.commit();
    const states = tracker.evaluate().states;

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ deviceCode: 'RC-103', mode: 'defrost' });
  });
});

describe('трекер здоровья при ребалансе', () => {
  it('до первого назначения ничего не публикует, после него только свои приборы', () => {
    const { tracker } = bare();
    tracker.observeCycle(cycle('RC-101', true, START + 1_000));

    expect(tracker.evaluate()).toEqual({ states: [], events: [] });
    expect(tracker.draftFrames().observe(door('RC-102', START + 1_000, true))).toEqual([]);

    tracker.adopt(['RC-101', 'PM-207'], []);
    const states = tracker.evaluate().states;

    expect(states.map((state) => state.deviceCode).sort()).toEqual(['PM-207', 'RC-101']);
    expect(states.find((state) => state.deviceCode === 'RC-101')).toMatchObject({
      status: 'unknown',
      reason: 'startup_grace',
      lastOkAt: null,
    });
  });

  it('восстановленное состояние не публикуется повторно и не даёт ложных событий', () => {
    const { clock, tracker } = bare();
    clock.advance(600_000);
    tracker.adopt(
      ['RC-101', 'RC-102', 'RC-103', 'PM-201'],
      [
        recorded('RC-101', { mode: 'defrost' }),
        recorded('RC-102', {
          status: 'offline',
          reason: 'consecutive_errors',
          consecutiveErrors: 5,
        }),
        recorded('RC-103', { status: 'degraded', reason: 'stale' }),
        recorded('PM-201', { status: 'unknown', reason: 'no_data', lastOkAt: null }),
      ],
    );

    expect(tracker.evaluate()).toEqual({ states: [], events: [] });

    const first = tracker.draftFrames();
    expect(
      first.observe({
        deviceCode: 'RC-101',
        atMs: START + 601_000,
        mode: 'defrost',
        doorOpen: true,
        defrostActive: true,
      }),
    ).toEqual([]);
    expect(
      first.observe({
        deviceCode: 'RC-103',
        atMs: START + 601_000,
        mode: 'defrost',
        doorOpen: false,
        defrostActive: true,
      }),
    ).toEqual([]);
    first.commit();
    clock.advance(5_000);
    const afterFrames = tracker.evaluate();
    tracker.confirmPublished(afterFrames.states);

    expect(afterFrames).toEqual({
      states: [
        expect.objectContaining({
          deviceCode: 'RC-103',
          status: 'degraded',
          mode: 'defrost',
          since: iso(HOUR_AGO),
          lastOkAt: iso(HOUR_AGO),
        }) as unknown,
      ],
      events: [],
    });

    const second = tracker.draftFrames();
    expect(
      second.observe({
        deviceCode: 'RC-101',
        atMs: START + 611_000,
        mode: 'defrost',
        doorOpen: false,
        defrostActive: true,
      }),
    ).toEqual([
      { deviceCode: 'RC-101', kind: 'door_closed', occurredAt: iso(START + 611_000), payload: {} },
    ]);

    tracker.observeCycle(cycle('RC-102', true, START + 612_000));
    clock.advance(5_000);
    const recovered = tracker.evaluate();

    expect(recovered.states).toEqual([
      expect.objectContaining({ deviceCode: 'RC-102', status: 'online', consecutiveErrors: 0 }),
    ]);
    expect(recovered.events).toEqual([
      expect.objectContaining({
        deviceCode: 'RC-102',
        kind: 'came_online',
        payload: { from: 'offline' },
      }),
    ]);
  });

  it('online из базы подтверждён на момент переезда, а без циклов протухает по политике', () => {
    const { clock, tracker } = bare();
    clock.advance(600_000);
    tracker.adopt(['RC-101'], [recorded('RC-101')]);

    clock.advance(DEFAULT_HEALTH_POLICY.staleAfterMs - 1_000);
    expect(tracker.evaluate()).toEqual({ states: [], events: [] });

    clock.advance(2_000);
    expect(tracker.evaluate()).toEqual({
      states: [
        expect.objectContaining({
          deviceCode: 'RC-101',
          status: 'degraded',
          reason: 'stale',
          lastOkAt: iso(HOUR_AGO),
        }) as unknown,
      ],
      events: [],
    });
  });

  it('прибор без записанного состояния получает окно startup_grace от момента переезда', () => {
    const { clock, tracker } = bare();
    clock.advance(600_000);
    tracker.adopt(['RC-101'], []);

    expect(tracker.evaluate().states).toEqual([
      expect.objectContaining({ deviceCode: 'RC-101', status: 'unknown', reason: 'startup_grace' }),
    ]);

    clock.advance(DEFAULT_HEALTH_POLICY.startupGraceMs);
    expect(tracker.evaluate().states).toEqual([
      expect.objectContaining({ deviceCode: 'RC-101', status: 'unknown', reason: 'no_data' }),
    ]);
  });

  it('если состояние не прочитать, прибор молчит, пока статус не выяснится, и не выдумывает событий', () => {
    const { clock, tracker } = bare();
    clock.advance(600_000);
    tracker.adopt(['RC-101', 'RC-102'], null);

    expect(tracker.evaluate()).toEqual({ states: [], events: [] });

    const draft = tracker.draftFrames();
    expect(
      draft.observe({
        deviceCode: 'RC-101',
        atMs: START + 601_000,
        mode: 'defrost',
        doorOpen: false,
        defrostActive: true,
      }),
    ).toEqual([]);
    draft.commit();
    tracker.observeCycle(cycle('RC-102', false, START + 602_000));
    clock.advance(3_000);
    expect(tracker.evaluate()).toEqual({ states: [], events: [] });

    tracker.observeCycle(cycle('RC-101', true, START + 604_000));
    clock.advance(1_000);
    const online = tracker.evaluate();
    tracker.confirmPublished(online.states);

    expect(online).toEqual({
      states: [
        expect.objectContaining({
          deviceCode: 'RC-101',
          status: 'online',
          reason: 'ok',
          mode: 'defrost',
        }) as unknown,
      ],
      events: [],
    });

    clock.advance(DEFAULT_HEALTH_POLICY.startupGraceMs);
    expect(tracker.evaluate()).toEqual({
      states: [
        expect.objectContaining({
          deviceCode: 'RC-102',
          status: 'unknown',
          reason: 'awaiting_success',
          consecutiveErrors: 1,
        }) as unknown,
      ],
      events: [],
    });
  });

  it('после отзыва прибор не публикуется, а черновик пачки не оживляет его трек', () => {
    const { tracker } = make();
    tracker.confirmPublished(tracker.evaluate().states);

    const draft = tracker.draftFrames();
    draft.observe({
      deviceCode: 'RC-103',
      atMs: START + 5_000,
      mode: 'defrost',
      doorOpen: false,
      defrostActive: true,
    });
    tracker.release(['RC-103']);
    draft.commit();
    tracker.observeCycle(cycle('RC-103', true, START + 6_000));

    expect(tracker.evaluate()).toEqual({ states: [], events: [] });

    tracker.adopt(['RC-103'], []);
    expect(tracker.evaluate().states).toEqual([
      expect.objectContaining({
        deviceCode: 'RC-103',
        status: 'unknown',
        mode: 'cooling',
        lastOkAt: null,
      }),
    ]);
  });
});
