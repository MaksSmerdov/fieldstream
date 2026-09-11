import { describe, expect, it } from 'vitest';
import { DEFAULT_HEALTH_POLICY } from '@fieldstream/contracts';
import type { PollCycle } from '@fieldstream/contracts';
import { DEMO_STAND } from '@fieldstream/device-profiles';
import { createFakeClock } from '@fieldstream/domain';
import type { FakeClock } from '@fieldstream/domain';
import { createHealthTracker } from '../../src/health/tracker.js';
import type { HealthTracker } from '../../src/health/tracker.js';

const START = Date.parse('2026-09-11T10:00:00Z');

const make = (): { clock: FakeClock; tracker: HealthTracker } => {
  const clock = createFakeClock(START);
  return {
    clock,
    tracker: createHealthTracker({ stand: DEMO_STAND, clock, policy: DEFAULT_HEALTH_POLICY }),
  };
};

const cycle = (deviceCode: string, ok: boolean, atMs: number): PollCycle => ({
  schema: 'poll.cycle',
  v: 1,
  ts: new Date(atMs).toISOString(),
  lineCode: 'L1',
  deviceCode,
  ok,
  errorKind: ok ? null : 'timeout',
  durationMs: 40,
  requestCount: 4,
  planMode: 'merged',
  traceId: '0123456789abcdef',
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
    const observe = (atMs: number, doorOpen: boolean): unknown =>
      tracker.observeFrame({
        deviceCode: 'RC-102',
        atMs,
        mode: 'cooling',
        doorOpen,
        defrostActive: false,
      });

    expect(observe(START + 1_000, false)).toEqual([]);
    expect(observe(START + 11_000, true)).toEqual([
      {
        deviceCode: 'RC-102',
        kind: 'door_opened',
        occurredAt: new Date(START + 11_000).toISOString(),
        payload: {},
      },
    ]);
  });

  it('смена режима публикует новое состояние только этого прибора', () => {
    const { tracker } = make();
    tracker.confirmPublished(tracker.evaluate().states);

    tracker.observeFrame({
      deviceCode: 'RC-103',
      atMs: START + 5_000,
      mode: 'defrost',
      doorOpen: false,
      defrostActive: true,
    });
    const states = tracker.evaluate().states;

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ deviceCode: 'RC-103', mode: 'defrost' });
  });
});
