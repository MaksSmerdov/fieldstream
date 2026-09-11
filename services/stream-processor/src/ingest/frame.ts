import type { DeviceMode, TelemetryRaw, TelemetryReading } from '@fieldstream/contracts';
import { QUALITY_CODE } from '@fieldstream/db';
import type { DeviceRef, ReadingRow } from '@fieldstream/db';
import { decodeFrame, listPlanEntries, profileByVersion } from '@fieldstream/device-profiles';
import { idleSpikeFilterState, spikeFilter } from '@fieldstream/domain';
import type { SpikeFilterState } from '@fieldstream/domain';
import type { DecodedValue } from '@fieldstream/modbus-codec';

/** Состояние фильтров скачков по ключу `прибор:метрика`. */
export type SpikeMemory = ReadonlyMap<string, SpikeFilterState>;

/** Что процессор узнал о приборе из кадра, кроме чисел: режим, дверь, оттайка. */
export interface FrameObservation {
  readonly deviceCode: string;
  readonly atMs: number;
  readonly mode: DeviceMode;
  readonly doorOpen: boolean | null;
  readonly defrostActive: boolean | null;
}

export type FrameRejection = 'unknown_device' | 'unknown_profile_version' | 'empty_frame';

export type FrameOutcome =
  | {
      readonly kind: 'accepted';
      readonly rows: readonly ReadingRow[];
      readonly reading: TelemetryReading;
      readonly observation: FrameObservation;
      readonly filters: ReadonlyMap<string, SpikeFilterState>;
    }
  | { readonly kind: 'rejected'; readonly errorClass: FrameRejection; readonly error: string };

export interface FrameContext {
  readonly refs: ReadonlyMap<string, DeviceRef>;
  readonly filters: SpikeMemory;
  readonly source: { readonly partition: number; readonly offset: string };
}

const rejected = (errorClass: FrameRejection, error: string): FrameOutcome => ({
  kind: 'rejected',
  errorClass,
  error,
});

/** Оттайка это нагрев змеевика и стекание воды после него. */
const isDefrost = (state: DecodedValue): boolean => state === 'heating' || state === 'draining';

/** Режим камеры по её собственным показаниям. Ручные режимы обслуживания придут командами. */
export const modeOf = (decoded: ReadonlyMap<string, DecodedValue>): DeviceMode =>
  isDefrost(decoded.get('defrost_state') ?? null) ? 'defrost' : 'cooling';

export const filterKey = (deviceCode: string, metricKey: string): string =>
  `${deviceCode}:${metricKey}`;

/**
 * Обработка одного сырого кадра: прибор ищется в топологии, профиль строго той версии,
 * которой кадр прочитан, затем разбор, фильтр скачков и режим. Функция чистая: новое
 * состояние фильтров возвращается наружу и применяется только после успешной записи,
 * поэтому повтор той же пачки после сбоя даёт тот же результат.
 */
export const processFrame = (frame: TelemetryRaw, context: FrameContext): FrameOutcome => {
  const ref = context.refs.get(frame.deviceCode);
  if (ref === undefined) {
    return rejected('unknown_device', `прибора ${frame.deviceCode} нет в топологии`);
  }

  const profile = profileByVersion(frame.profileKey, frame.profileVersion);
  if (profile === undefined) {
    return rejected(
      'unknown_profile_version',
      `нет профиля ${frame.profileKey} версии ${String(frame.profileVersion)}`,
    );
  }

  const metrics = decodeFrame(profile, frame.blocks);
  if (metrics.length === 0) {
    return rejected('empty_frame', 'в кадре нет ни одного параметра профиля');
  }

  const params = new Map(listPlanEntries(profile).map((entry) => [entry.param.key, entry.param]));
  const filters = new Map<string, SpikeFilterState>();
  const rows: ReadingRow[] = [];
  const values: Record<string, number | null> = {};
  let substituted = false;

  for (const metric of metrics) {
    const param = params.get(metric.key);
    let value = metric.value;
    let quality: number = QUALITY_CODE.ok;

    if (param?.maxDelta !== undefined && param.enum === undefined && param.bits === undefined) {
      const key = filterKey(frame.deviceCode, metric.key);
      const result = spikeFilter(context.filters.get(key) ?? idleSpikeFilterState(), metric.value, {
        maxDelta: param.maxDelta,
        acceptAfter: param.acceptAfter,
      });
      filters.set(key, result.state);
      if (result.rejected) {
        value = result.value;
        quality = QUALITY_CODE.substituted;
        substituted = true;
      }
    }

    rows.push({ ts: frame.ts, deviceId: ref.deviceId, metricKey: metric.key, value, quality });
    values[metric.key] = value;
  }

  const decoded = new Map(metrics.map((metric) => [metric.key, metric.decoded]));
  const mode = modeOf(decoded);
  const door = decoded.get('door_open');
  const defrost = decoded.get('defrost_state');

  return {
    kind: 'accepted',
    rows,
    filters,
    observation: {
      deviceCode: frame.deviceCode,
      atMs: Date.parse(frame.ts),
      mode,
      doorOpen: door === undefined ? null : door === 'open',
      defrostActive: defrost === undefined ? null : isDefrost(defrost),
    },
    reading: {
      schema: 'telemetry.reading',
      v: 1,
      deviceCode: frame.deviceCode,
      ts: frame.ts,
      mode,
      metrics: values,
      quality: substituted ? 'substituted' : 'ok',
      sourceOffset: context.source,
      traceId: frame.traceId,
    },
  };
};
