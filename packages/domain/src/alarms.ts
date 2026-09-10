import type { AlarmRule, AlarmState, DeviceMode, Quality, Severity } from '@fieldstream/contracts';
import { MUTED_MODES } from '@fieldstream/contracts';

/** Граница уставки, по которой сработал аларм. */
export type AlarmBoundary = 'min' | 'max';

/** Значение метрики в текущем цикле вместе с качеством. */
export interface MetricSample {
  value: number | null;
  quality: Quality;
}

/**
 * Состояние аларма по одной метрике между циклами. Размеченное объединение:
 * у неподнятого аларма нет ни порога, ни важности, и выразить их нельзя.
 */
export type MetricAlarmState =
  | { raised: false; pendingBoundary: AlarmBoundary | null; violationCycles: number }
  | {
      raised: true;
      boundary: AlarmBoundary;
      severity: Severity;
      threshold: number;
      raisedAt: number;
    };

/** Состояние алармов прибора. Ключ это metricKey. */
export type DeviceAlarmState = Readonly<Record<string, MetricAlarmState>>;

/** Переход аларма за один цикл. Из него адаптер собирает alarm.event контрактов. */
export interface AlarmTransition {
  deviceCode: string;
  metricKey: string;
  mode: DeviceMode;
  state: AlarmState;
  severity: Severity;
  value: number | null;
  threshold: number | null;
  boundary: AlarmBoundary;
  occurredAt: number;
}

export interface EvaluateDeviceAlarmsInput {
  deviceCode: string;
  mode: DeviceMode;
  metrics: Readonly<Record<string, MetricSample>>;
  rules: readonly AlarmRule[];
  prevState: DeviceAlarmState;
  nowMs: number;
}

export interface DeviceAlarmEvaluation {
  transitions: AlarmTransition[];
  state: DeviceAlarmState;
}

/** Исходное состояние метрики: аларма нет, нарушения не накоплены. */
export const idleAlarmState = (): MetricAlarmState => ({
  raised: false,
  pendingBoundary: null,
  violationCycles: 0,
});

/** Нарушена ли уставка: возвращает границу с порогом или null. */
const detectViolation = (
  rule: AlarmRule,
  value: number,
): { boundary: AlarmBoundary; threshold: number } | null => {
  if (rule.maxValue !== null && value > rule.maxValue) {
    return { boundary: 'max', threshold: rule.maxValue };
  }
  if (rule.minValue !== null && value < rule.minValue) {
    return { boundary: 'min', threshold: rule.minValue };
  }
  return null;
};

/** Вышло ли значение из зоны возврата: гистерезис гасит дребезг ровно на границе. */
const isBackToNormal = (rule: AlarmRule, boundary: AlarmBoundary, value: number): boolean =>
  boundary === 'max'
    ? rule.maxValue === null || value < rule.maxValue - rule.hysteresis
    : rule.minValue === null || value > rule.minValue + rule.hysteresis;

/** Поднятый аларм: важность и порог для снятия берутся отсюда, а не по умолчанию. */
type RaisedAlarmState = Extract<MetricAlarmState, { raised: true }>;

/** Переход снятия аларма по сохранённому состоянию. */
const clearedTransition = (
  input: EvaluateDeviceAlarmsInput,
  metricKey: string,
  prev: RaisedAlarmState,
  value: number | null,
): AlarmTransition => ({
  deviceCode: input.deviceCode,
  metricKey,
  mode: input.mode,
  state: 'cleared',
  severity: prev.severity,
  value,
  threshold: prev.threshold,
  boundary: prev.boundary,
  occurredAt: input.nowMs,
});

/** Правила текущего режима по метрикам: ключ уставки это (прибор, метрика, режим). */
const rulesForMode = (input: EvaluateDeviceAlarmsInput): Map<string, AlarmRule> => {
  const byMetric = new Map<string, AlarmRule>();

  for (const rule of input.rules) {
    if (rule.enabled && rule.deviceCode === input.deviceCode && rule.mode === input.mode) {
      byMetric.set(rule.metricKey, rule);
    }
  }

  return byMetric;
};

/**
 * Пересчитывает алармы прибора за один цикл опроса. Чистая функция: входное состояние
 * не мутируется, новое возвращается рядом с упорядоченным списком переходов.
 */
export const evaluateDeviceAlarms = (input: EvaluateDeviceAlarmsInput): DeviceAlarmEvaluation => {
  const rules = rulesForMode(input);
  const muted = MUTED_MODES.includes(input.mode);
  const metricKeys = [...new Set([...Object.keys(input.prevState), ...rules.keys()])].sort();
  const transitions: AlarmTransition[] = [];
  const state: Record<string, MetricAlarmState> = {};

  for (const metricKey of metricKeys) {
    const prev = input.prevState[metricKey] ?? idleAlarmState();
    const sample = input.metrics[metricKey];
    const value = sample !== undefined && sample.quality !== 'bad' ? sample.value : null;

    if (muted) {
      if (prev.raised) {
        transitions.push(clearedTransition(input, metricKey, prev, value));
      }
      state[metricKey] = idleAlarmState();
      continue;
    }

    const rule = rules.get(metricKey);

    if (rule === undefined) {
      if (prev.raised) {
        transitions.push(clearedTransition(input, metricKey, prev, value));
      }
      state[metricKey] = idleAlarmState();
      continue;
    }

    if (value === null) {
      state[metricKey] = prev;
      continue;
    }

    if (prev.raised) {
      if (isBackToNormal(rule, prev.boundary, value)) {
        transitions.push(clearedTransition(input, metricKey, prev, value));
        state[metricKey] = idleAlarmState();
      } else {
        state[metricKey] = prev;
      }
      continue;
    }

    const violation = detectViolation(rule, value);

    if (violation === null) {
      state[metricKey] = idleAlarmState();
      continue;
    }

    const cycles = prev.pendingBoundary === violation.boundary ? prev.violationCycles + 1 : 1;

    if (cycles < rule.debounceCycles) {
      state[metricKey] = {
        raised: false,
        pendingBoundary: violation.boundary,
        violationCycles: cycles,
      };
      continue;
    }

    transitions.push({
      deviceCode: input.deviceCode,
      metricKey,
      mode: input.mode,
      state: 'raised',
      severity: rule.severity,
      value,
      threshold: violation.threshold,
      boundary: violation.boundary,
      occurredAt: input.nowMs,
    });
    state[metricKey] = {
      raised: true,
      boundary: violation.boundary,
      severity: rule.severity,
      threshold: violation.threshold,
      raisedAt: input.nowMs,
    };
  }

  return { transitions, state };
};
