import type { AlarmEvent, AlarmRule } from '@fieldstream/contracts';
import { qualityOf } from '@fieldstream/db';
import type { AlarmClearRow, AlarmEventRow, ReadingRow } from '@fieldstream/db';
import {
  alarmDedupeKey,
  alarmIdOf,
  evaluateDeviceAlarms,
  toIsoTimestamp,
} from '@fieldstream/domain';
import type { AlarmTransition, DeviceAlarmState, MetricSample } from '@fieldstream/domain';
import type { FrameObservation } from './frame.js';

/** Состояние алармов всех приборов по коду прибора. */
export type AlarmMemory = ReadonlyMap<string, DeviceAlarmState>;

/** Переход вместе с тем, что нужно для записи и публикации: прибор в базе и след запроса. */
export interface AlarmOutcome {
  readonly transition: AlarmTransition;
  readonly deviceId: number;
  readonly traceId: string;
  readonly dedupeKey: string;
}

export interface FrameAlarmsInput {
  readonly observation: FrameObservation;
  readonly rows: readonly ReadingRow[];
  readonly rules: readonly AlarmRule[];
  readonly prevState: DeviceAlarmState;
}

/** Значения кадра для движка: качество берётся по метрике, а не одно на весь кадр. */
const samplesOf = (rows: readonly ReadingRow[]): Record<string, MetricSample> => {
  const samples: Record<string, MetricSample> = {};
  for (const row of rows) {
    samples[row.metricKey] = { value: row.value, quality: qualityOf(row.quality) };
  }
  return samples;
};

/**
 * Алармы одного кадра. Такт движка это такт опроса, поэтому debounce считается в циклах
 * прибора, а не в секундах, и время берётся из кадра, а не из системных часов.
 */
export const evaluateFrameAlarms = (
  input: FrameAlarmsInput,
): { transitions: AlarmTransition[]; state: DeviceAlarmState } =>
  evaluateDeviceAlarms({
    deviceCode: input.observation.deviceCode,
    mode: input.observation.mode,
    metrics: samplesOf(input.rows),
    rules: input.rules,
    prevState: input.prevState,
    nowMs: input.observation.atMs,
  });

/** Ключ эпизода вместе с переходом: по нему строка подъёма и её снятие находят друг друга. */
export const toOutcome = (
  transition: AlarmTransition,
  deviceId: number,
  traceId: string,
): AlarmOutcome => ({
  transition,
  deviceId,
  traceId,
  dedupeKey: alarmDedupeKey({
    deviceCode: transition.deviceCode,
    metricKey: transition.metricKey,
    mode: transition.mode,
    raisedAt: transition.raisedAt,
  }),
});

/** Строка подъёма для базы. */
export const raisedRowOf = (outcome: AlarmOutcome): AlarmEventRow => ({
  alarmId: alarmIdOf(outcome.dedupeKey),
  deviceId: outcome.deviceId,
  metricKey: outcome.transition.metricKey,
  mode: outcome.transition.mode,
  severity: outcome.transition.severity,
  boundary: outcome.transition.boundary,
  value: outcome.transition.value,
  threshold: outcome.transition.threshold,
  occurredAt: toIsoTimestamp(outcome.transition.occurredAt),
  dedupeKey: outcome.dedupeKey,
});

/** Строка снятия: закрывает эпизод, а не заводит новый. */
export const clearedRowOf = (outcome: AlarmOutcome): AlarmClearRow => ({
  dedupeKey: outcome.dedupeKey,
  clearedAt: toIsoTimestamp(outcome.transition.occurredAt),
  clearedValue: outcome.transition.value,
});

/** Событие для топика алармов: у подъёма и снятия эпизода общий ключ и общий идентификатор. */
export const alarmEventOf = (outcome: AlarmOutcome): AlarmEvent => ({
  schema: 'alarm.event',
  v: 1,
  alarmId: alarmIdOf(outcome.dedupeKey),
  dedupeKey: outcome.dedupeKey,
  deviceCode: outcome.transition.deviceCode,
  metricKey: outcome.transition.metricKey,
  mode: outcome.transition.mode,
  state: outcome.transition.state,
  severity: outcome.transition.severity,
  value: outcome.transition.value,
  threshold: outcome.transition.threshold,
  boundary: outcome.transition.boundary,
  occurredAt: toIsoTimestamp(outcome.transition.occurredAt),
  traceId: outcome.traceId,
});
