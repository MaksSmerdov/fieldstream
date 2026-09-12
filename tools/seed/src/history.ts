import type { DeviceProfile, ParamSpec } from '@fieldstream/contracts';
import { listPlanEntries } from '@fieldstream/device-profiles';

/** Как рисовать одну метрику в истории: суточная волна вокруг середины её диапазона. */
export interface MetricWave {
  readonly metricKey: string;
  readonly center: number;
  readonly amplitude: number;
  /** Период в секундах: у разных метрик он разный, иначе вся история дышит в такт. */
  readonly periodSec: number;
  readonly phase: number;
  readonly precision: number;
  readonly monotonic: boolean;
}

/** Детерминированный хеш: у засева не должно быть случайности, иначе повтор даст другую историю. */
const hash = (text: string): number => {
  let value = 0x811c9dc5;

  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }

  return value;
};

const DAY_SEC = 86_400;

/** Волна метрики по её же инженерному диапазону: засев не выходит за шкалу прибора. */
const waveOf = (profileKey: string, param: ParamSpec): MetricWave | null => {
  if (param.enum !== undefined || param.bits !== undefined) return null;
  const range = param.range;
  if (range === undefined) return null;

  const salt = hash(`${profileKey}:${param.key}`);
  const span = range.max - range.min;

  return {
    metricKey: param.key,
    center: range.min + span / 2,
    amplitude: span * 0.3,
    periodSec: DAY_SEC / (1 + (salt % 3)),
    phase: ((salt >>> 8) % 1000) / 1000,
    precision: param.precision,
    monotonic: range.monotonic,
  };
};

/** Числовые метрики модели, которые имеет смысл засевать историей. */
export const wavesOf = (profile: DeviceProfile): MetricWave[] =>
  listPlanEntries(profile)
    .map((entry) => waveOf(profile.profileKey, entry.param))
    .filter((wave): wave is MetricWave => wave !== null);

/** Происшествие в истории: окно, где метрика уходит за уставку и поднимает аларм. */
export interface Incident {
  readonly deviceCode: string;
  readonly metricKey: string;
  /** Сдвиг начала от конца окна засева, в часах назад. */
  readonly hoursAgo: number;
  readonly durationMin: number;
  readonly value: number;
  readonly threshold: number;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly boundary: 'min' | 'max';
}

/**
 * Три происшествия недели. Они заданы руками, а не случайно: на экранах должно быть
 * что показывать, и одно и то же на каждом стенде.
 */
export const INCIDENTS: readonly Incident[] = Object.freeze([
  {
    deviceCode: 'RC-103',
    metricKey: 'supply_temp_c',
    hoursAgo: 52,
    durationMin: 45,
    value: 4.2,
    threshold: 2,
    severity: 'warning',
    boundary: 'max',
  },
  {
    deviceCode: 'RC-107',
    metricKey: 'superheat_k',
    hoursAgo: 27,
    durationMin: 20,
    value: 18.4,
    threshold: 16,
    severity: 'critical',
    boundary: 'max',
  },
  {
    deviceCode: 'PM-203',
    metricKey: 'voltage_l2_v',
    hoursAgo: 9,
    durationMin: 12,
    value: 203.5,
    threshold: 207,
    severity: 'warning',
    boundary: 'min',
  },
]);
