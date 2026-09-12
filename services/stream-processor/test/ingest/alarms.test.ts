import { describe, expect, it } from 'vitest';
import type { AlarmRule } from '@fieldstream/contracts';
import { QUALITY_CODE } from '@fieldstream/db';
import type { ReadingRow } from '@fieldstream/db';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { DeviceAlarmState } from '@fieldstream/domain';
import {
  alarmEventOf,
  clearedRowOf,
  evaluateFrameAlarms,
  raisedRowOf,
  toOutcome,
} from '../../src/ingest/alarms.js';
import type { FrameObservation } from '../../src/ingest/frame.js';

const DEVICE = 'RC-101';
const METRIC = 'supply_temp_c';
const T0 = Date.parse('2026-02-11T10:00:00.000Z');
const CYCLE_MS = 10_000;

const RULE: AlarmRule = {
  deviceCode: DEVICE,
  metricKey: METRIC,
  mode: 'cooling',
  minValue: -28,
  maxValue: 2,
  hysteresis: 1,
  debounceCycles: 3,
  severity: 'warning',
  enabled: true,
};

const observation = (cycle: number): FrameObservation => ({
  deviceCode: DEVICE,
  atMs: T0 + cycle * CYCLE_MS,
  mode: 'cooling',
  doorOpen: null,
  defrostActive: null,
});

const rows = (cycle: number, value: number, quality: number = QUALITY_CODE.ok): ReadingRow[] => [
  { ts: toIsoTimestamp(T0 + cycle * CYCLE_MS), deviceId: 7, metricKey: METRIC, value, quality },
];

/** Прогон нескольких циклов подряд с переносом состояния, как это делает потребитель пачки. */
const run = (values: readonly (readonly [number, number])[]) => {
  let state: DeviceAlarmState = {};
  const transitions = [];

  for (const [cycle, value] of values) {
    const result = evaluateFrameAlarms({
      observation: observation(cycle),
      rows: rows(cycle, value),
      rules: [RULE],
      prevState: state,
    });
    state = result.state;
    transitions.push(...result.transitions);
  }

  return { state, transitions };
};

describe('алармы на пути кадра', () => {
  it('поднимаются только после заданного числа циклов нарушения', () => {
    expect(run([[0, 4.5]]).transitions).toHaveLength(0);
    expect(
      run([
        [0, 4.5],
        [1, 4.7],
      ]).transitions,
    ).toHaveLength(0);

    const raised = run([
      [0, 4.5],
      [1, 4.7],
      [2, 5.1],
    ]).transitions;

    expect(raised).toHaveLength(1);
    expect(raised[0]?.state).toBe('raised');
    expect(raised[0]?.occurredAt).toBe(T0 + 2 * CYCLE_MS);
  });

  /** Возврат ровно к границе не считается нормой: гистерезис гасит дребезг на пороге. */
  it('снимаются только после возврата за зону гистерезиса', () => {
    const onTheEdge = run([
      [0, 4.5],
      [1, 4.7],
      [2, 5.1],
      [3, 1.5],
    ]).transitions;
    expect(onTheEdge).toHaveLength(1);

    const back = run([
      [0, 4.5],
      [1, 4.7],
      [2, 5.1],
      [3, 0.5],
    ]).transitions;
    expect(back.map((item) => item.state)).toEqual(['raised', 'cleared']);
  });

  it('подъём и снятие это один эпизод: ключ, идентификатор и строки совпадают', () => {
    const { transitions } = run([
      [0, 4.5],
      [1, 4.7],
      [2, 5.1],
      [3, 0.5],
    ]);
    const [raised, cleared] = transitions.map((item) => toOutcome(item, 7, 'trace-1'));

    expect(raised?.dedupeKey).toBe(cleared?.dedupeKey);
    expect(raised?.dedupeKey).toBe(`${DEVICE}|${METRIC}|cooling|${toIsoTimestamp(T0 + 20_000)}`);
    expect(alarmEventOf(raised!).alarmId).toBe(alarmEventOf(cleared!).alarmId);
    expect(raisedRowOf(raised!).occurredAt).toBe(toIsoTimestamp(T0 + 20_000));
    expect(clearedRowOf(cleared!).clearedAt).toBe(toIsoTimestamp(T0 + 30_000));
    expect(clearedRowOf(cleared!).clearedValue).toBe(0.5);
  });

  it('значение с плохим качеством не двигает счётчик нарушений', () => {
    let state: DeviceAlarmState = {};
    for (const cycle of [0, 1, 2, 3]) {
      state = evaluateFrameAlarms({
        observation: observation(cycle),
        rows: rows(cycle, 9.9, QUALITY_CODE.bad),
        rules: [RULE],
        prevState: state,
      }).state;
    }

    expect(state[METRIC]).toEqual({ raised: false, pendingBoundary: null, violationCycles: 0 });
  });
});
