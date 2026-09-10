import { describe, expect, it } from 'vitest';
import type { AlarmRule } from '@fieldstream/contracts';
import type {
  AlarmBoundary,
  DeviceAlarmState,
  EvaluateDeviceAlarmsInput,
  MetricAlarmState,
  MetricSample,
} from './alarms.js';
import { evaluateDeviceAlarms, idleAlarmState } from './alarms.js';
import { createFakeClock } from './clock.js';

const T0 = Date.UTC(2026, 0, 1);
const DEVICE = 'RC-101';

const rule = (over: Partial<AlarmRule> = {}): AlarmRule => ({
  deviceCode: DEVICE,
  metricKey: 'temp',
  mode: 'cooling',
  minValue: null,
  maxValue: 5,
  hysteresis: 0,
  debounceCycles: 1,
  severity: 'warning',
  enabled: true,
  ...over,
});

const ok = (value: number | null): MetricSample => ({ value, quality: 'ok' });

const raisedState = (boundary: AlarmBoundary, threshold: number): MetricAlarmState => ({
  raised: true,
  boundary,
  severity: 'critical',
  threshold,
  raisedAt: T0,
});

const evaluate = (over: Partial<EvaluateDeviceAlarmsInput> = {}) =>
  evaluateDeviceAlarms({
    deviceCode: DEVICE,
    mode: 'cooling',
    metrics: { temp: ok(0) },
    rules: [rule()],
    prevState: {},
    nowMs: T0,
    ...over,
  });

describe('evaluateDeviceAlarms: подбор правила', () => {
  it('без правила по метрике не делает ничего', () => {
    const result = evaluate({ metrics: { pressure: ok(999) }, rules: [] });

    expect(result.transitions).toEqual([]);
    expect(result.state).toEqual({});
  });

  it('правило другого режима не применяется', () => {
    const result = evaluate({
      mode: 'defrost',
      metrics: { temp: ok(20) },
      rules: [rule({ mode: 'cooling', maxValue: 5 })],
    });

    expect(result.transitions).toEqual([]);
  });

  it('правило другого прибора не применяется', () => {
    const result = evaluate({
      metrics: { temp: ok(20) },
      rules: [rule({ deviceCode: 'RC-102' })],
    });

    expect(result.transitions).toEqual([]);
  });

  it('выключенное правило не применяется', () => {
    const result = evaluate({ metrics: { temp: ok(20) }, rules: [rule({ enabled: false })] });

    expect(result.transitions).toEqual([]);
  });

  it('снимает поднятый аларм, если правило удалено из набора', () => {
    const result = evaluate({
      metrics: { temp: ok(-20) },
      rules: [],
      prevState: { temp: raisedState('max', 5) },
    });

    expect(result.transitions).toEqual([
      {
        deviceCode: DEVICE,
        metricKey: 'temp',
        mode: 'cooling',
        state: 'cleared',
        severity: 'critical',
        value: -20,
        threshold: 5,
        boundary: 'max',
        occurredAt: T0,
      },
    ]);
    expect(result.state['temp']).toEqual(idleAlarmState());
  });

  it('снимает поднятый аларм, если правило переведено в enabled false', () => {
    const result = evaluate({
      metrics: { temp: ok(-20) },
      rules: [rule({ minValue: -25, maxValue: null, enabled: false })],
      prevState: { temp: raisedState('min', -25) },
    });

    expect(result.transitions).toEqual([
      {
        deviceCode: DEVICE,
        metricKey: 'temp',
        mode: 'cooling',
        state: 'cleared',
        severity: 'critical',
        value: -20,
        threshold: -25,
        boundary: 'min',
        occurredAt: T0,
      },
    ]);
    expect(result.state['temp']).toEqual(idleAlarmState());
  });

  it('пропавшее правило гасит и накопленный счётчик нарушений', () => {
    const result = evaluate({
      metrics: { temp: ok(9) },
      rules: [],
      prevState: { temp: { raised: false, pendingBoundary: 'max', violationCycles: 2 } },
    });

    expect(result.transitions).toEqual([]);
    expect(result.state['temp']).toEqual(idleAlarmState());
  });
});

describe('evaluateDeviceAlarms: подъём и снятие', () => {
  it('поднимает аларм по верхней границе', () => {
    const clock = createFakeClock(T0);
    const result = evaluate({ metrics: { temp: ok(7.5) }, nowMs: clock.now() });

    expect(result.transitions).toEqual([
      {
        deviceCode: DEVICE,
        metricKey: 'temp',
        mode: 'cooling',
        state: 'raised',
        severity: 'warning',
        value: 7.5,
        threshold: 5,
        boundary: 'max',
        occurredAt: T0,
      },
    ]);
    expect(result.state['temp']).toEqual({
      raised: true,
      boundary: 'max',
      severity: 'warning',
      threshold: 5,
      raisedAt: T0,
    });
  });

  it('поднимает аларм по нижней границе с важностью из правила', () => {
    const result = evaluate({
      metrics: { temp: ok(-30) },
      rules: [rule({ minValue: -25, maxValue: null, severity: 'critical' })],
    });

    expect(result.transitions[0]).toMatchObject({
      state: 'raised',
      boundary: 'min',
      threshold: -25,
      severity: 'critical',
      value: -30,
    });
  });

  it('значение ровно на границе нарушением не считается', () => {
    const result = evaluate({ metrics: { temp: ok(5) } });

    expect(result.transitions).toEqual([]);
    expect(result.state['temp']).toEqual(idleAlarmState());
  });

  it('поднятый аларм не поднимается повторно на следующем цикле', () => {
    const prevState: DeviceAlarmState = { temp: raisedState('max', 5) };
    const result = evaluate({ metrics: { temp: ok(9) }, prevState });

    expect(result.transitions).toEqual([]);
    expect(result.state['temp']).toEqual(prevState['temp']);
  });

  it('снимает аларм при возврате в норму', () => {
    const clock = createFakeClock(T0);
    clock.advance(60_000);

    const result = evaluate({
      metrics: { temp: ok(1) },
      prevState: { temp: raisedState('max', 5) },
      nowMs: clock.now(),
    });

    expect(result.transitions).toEqual([
      {
        deviceCode: DEVICE,
        metricKey: 'temp',
        mode: 'cooling',
        state: 'cleared',
        severity: 'critical',
        value: 1,
        threshold: 5,
        boundary: 'max',
        occurredAt: T0 + 60_000,
      },
    ]);
    expect(result.state['temp']).toEqual(idleAlarmState());
  });
});

describe('evaluateDeviceAlarms: гистерезис', () => {
  const hysteresisRule = rule({ maxValue: 5, hysteresis: 2 });

  it('не снимает аларм по верхней границе внутри зоны возврата', () => {
    const result = evaluate({
      metrics: { temp: ok(4) },
      rules: [hysteresisRule],
      prevState: { temp: raisedState('max', 5) },
    });

    expect(result.transitions).toEqual([]);
    expect(result.state['temp']).toMatchObject({ raised: true });
  });

  it('снимает аларм по верхней границе только ниже maxValue минус гистерезис', () => {
    const inZone = evaluate({
      metrics: { temp: ok(3) },
      rules: [hysteresisRule],
      prevState: { temp: raisedState('max', 5) },
    });
    const belowZone = evaluate({
      metrics: { temp: ok(2.9) },
      rules: [hysteresisRule],
      prevState: { temp: raisedState('max', 5) },
    });

    expect(inZone.transitions).toEqual([]);
    expect(belowZone.transitions[0]).toMatchObject({ state: 'cleared', value: 2.9 });
  });

  it('снимает аларм по нижней границе только выше minValue плюс гистерезис', () => {
    const lowRule = rule({ minValue: -25, maxValue: null, hysteresis: 2 });
    const inZone = evaluate({
      metrics: { temp: ok(-23) },
      rules: [lowRule],
      prevState: { temp: raisedState('min', -25) },
    });
    const aboveZone = evaluate({
      metrics: { temp: ok(-22.9) },
      rules: [lowRule],
      prevState: { temp: raisedState('min', -25) },
    });

    expect(inZone.transitions).toEqual([]);
    expect(aboveZone.transitions[0]).toMatchObject({ state: 'cleared', boundary: 'min' });
  });
});

describe('evaluateDeviceAlarms: debounce', () => {
  const debounced = rule({ debounceCycles: 3 });

  it('поднимает аларм только после трёх подряд нарушений', () => {
    const clock = createFakeClock(T0);
    let state: DeviceAlarmState = {};
    const raisedOn: number[] = [];

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      clock.advance(10_000);
      const result = evaluate({
        metrics: { temp: ok(9) },
        rules: [debounced],
        prevState: state,
        nowMs: clock.now(),
      });
      state = result.state;
      if (result.transitions.length > 0) {
        raisedOn.push(cycle);
      }
    }

    expect(raisedOn).toEqual([3]);
    expect(state['temp']).toMatchObject({ raised: true, raisedAt: T0 + 30_000 });
  });

  it('возврат в норму сбрасывает счётчик нарушений', () => {
    const first = evaluate({ metrics: { temp: ok(9) }, rules: [debounced] });
    const back = evaluate({
      metrics: { temp: ok(1) },
      rules: [debounced],
      prevState: first.state,
    });
    const again = evaluate({ metrics: { temp: ok(9) }, rules: [debounced], prevState: back.state });

    expect(first.state['temp']).toEqual({
      raised: false,
      pendingBoundary: 'max',
      violationCycles: 1,
    });
    expect(back.state['temp']).toEqual(idleAlarmState());
    expect(again.state['temp']).toEqual({
      raised: false,
      pendingBoundary: 'max',
      violationCycles: 1,
    });
  });

  it('смена нарушенной границы начинает счёт заново', () => {
    const bothSides = rule({ minValue: -25, maxValue: 5, debounceCycles: 3 });
    const high = evaluate({ metrics: { temp: ok(9) }, rules: [bothSides] });
    const low = evaluate({
      metrics: { temp: ok(-30) },
      rules: [bothSides],
      prevState: high.state,
    });

    expect(low.state['temp']).toEqual({
      raised: false,
      pendingBoundary: 'min',
      violationCycles: 1,
    });
  });
});

describe('evaluateDeviceAlarms: плохие значения', () => {
  it('значение null не поднимает аларм и не двигает счётчик', () => {
    const debounced = rule({ debounceCycles: 3 });
    const first = evaluate({ metrics: { temp: ok(9) }, rules: [debounced] });
    const gap = evaluate({
      metrics: { temp: ok(null) },
      rules: [debounced],
      prevState: first.state,
    });

    expect(gap.transitions).toEqual([]);
    expect(gap.state['temp']).toEqual(first.state['temp']);
  });

  it('quality bad не поднимает аларм, даже если значение вне уставки', () => {
    const result = evaluate({ metrics: { temp: { value: 99, quality: 'bad' } } });

    expect(result.transitions).toEqual([]);
    expect(result.state['temp']).toEqual(idleAlarmState());
  });

  it('quality bad не снимает уже поднятый аларм', () => {
    const prevState: DeviceAlarmState = { temp: raisedState('max', 5) };
    const result = evaluate({ metrics: { temp: { value: 0, quality: 'bad' } }, prevState });

    expect(result.transitions).toEqual([]);
    expect(result.state['temp']).toEqual(prevState['temp']);
  });

  it('пропавшая из цикла метрика сохраняет состояние аларма', () => {
    const prevState: DeviceAlarmState = { temp: raisedState('max', 5) };
    const result = evaluate({ metrics: {}, prevState });

    expect(result.transitions).toEqual([]);
    expect(result.state['temp']).toEqual(prevState['temp']);
  });
});

describe('evaluateDeviceAlarms: заглушенные режимы', () => {
  it('в режиме service не поднимает алармы', () => {
    const result = evaluate({
      mode: 'service',
      metrics: { temp: ok(99) },
      rules: [rule({ mode: 'service' })],
    });

    expect(result.transitions).toEqual([]);
  });

  it('в режиме service снимает ранее поднятый аларм', () => {
    const result = evaluate({
      mode: 'service',
      metrics: { temp: ok(99) },
      rules: [],
      prevState: { temp: raisedState('max', 5) },
    });

    expect(result.transitions).toEqual([
      {
        deviceCode: DEVICE,
        metricKey: 'temp',
        mode: 'service',
        state: 'cleared',
        severity: 'critical',
        value: 99,
        threshold: 5,
        boundary: 'max',
        occurredAt: T0,
      },
    ]);
    expect(result.state['temp']).toEqual(idleAlarmState());
  });

  it('в режиме off сбрасывает накопленный счётчик нарушений', () => {
    const result = evaluate({
      mode: 'off',
      metrics: { temp: ok(99) },
      rules: [],
      prevState: { temp: { raised: false, pendingBoundary: 'max', violationCycles: 2 } },
    });

    expect(result.state['temp']).toEqual(idleAlarmState());
  });
});

describe('evaluateDeviceAlarms: порядок и чистота', () => {
  it('переходы упорядочены по ключу метрики независимо от порядка правил', () => {
    const result = evaluate({
      metrics: { temp: ok(9), pressure: ok(9), humidity: ok(9) },
      rules: [
        rule({ metricKey: 'temp' }),
        rule({ metricKey: 'humidity' }),
        rule({ metricKey: 'pressure' }),
      ],
    });

    expect(result.transitions.map((transition) => transition.metricKey)).toEqual([
      'humidity',
      'pressure',
      'temp',
    ]);
  });

  it('входное состояние не мутируется', () => {
    const prevState: DeviceAlarmState = { temp: raisedState('max', 5) };
    const before = structuredClone(prevState);

    const result = evaluate({ metrics: { temp: ok(0) }, prevState });

    expect(prevState).toEqual(before);
    expect(result.state).not.toBe(prevState);
  });
});
