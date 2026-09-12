import type { AlarmRule } from '@fieldstream/contracts';
import { pm3PhaseProfile } from './profiles/pm-3phase.js';
import { rc2000Profile } from './profiles/rc-2000.js';

/** Уставка модели прибора: код прибора подставляется при переносе в базу. */
export type ProfileAlarmRule = Omit<AlarmRule, 'deviceCode'>;

/** Уставки трёх фаз задаются одинаково: разница только в номере фазы. */
const perPhase = (
  metric: (phase: string) => string,
  rule: Omit<ProfileAlarmRule, 'metricKey'>,
): ProfileAlarmRule[] => ['l1', 'l2', 'l3'].map((phase) => ({ ...rule, metricKey: metric(phase) }));

/**
 * Уставки холодильного контроллера. В оттайке границы температур подняты, а перегрев
 * не контролируется вообще: компрессор в это время камеру не качает. Именно из-за этого
 * уставка привязана к режиму, а не к прибору.
 */
const rc2000Rules: readonly ProfileAlarmRule[] = [
  {
    metricKey: 'supply_temp_c',
    mode: 'cooling',
    minValue: -28,
    maxValue: 2,
    hysteresis: 1,
    debounceCycles: 3,
    severity: 'warning',
    enabled: true,
  },
  {
    metricKey: 'return_temp_c',
    mode: 'cooling',
    minValue: -26,
    maxValue: 5,
    hysteresis: 1,
    debounceCycles: 3,
    severity: 'warning',
    enabled: true,
  },
  {
    metricKey: 'evap_temp_c',
    mode: 'cooling',
    minValue: -28,
    maxValue: 0,
    hysteresis: 1,
    debounceCycles: 3,
    severity: 'info',
    enabled: true,
  },
  {
    metricKey: 'superheat_k',
    mode: 'cooling',
    minValue: 1,
    maxValue: 16,
    hysteresis: 0.5,
    debounceCycles: 3,
    severity: 'critical',
    enabled: true,
  },
  {
    metricKey: 'supply_temp_c',
    mode: 'defrost',
    minValue: -28,
    maxValue: 12,
    hysteresis: 1,
    debounceCycles: 6,
    severity: 'warning',
    enabled: true,
  },
  {
    metricKey: 'return_temp_c',
    mode: 'defrost',
    minValue: -26,
    maxValue: 14,
    hysteresis: 1,
    debounceCycles: 6,
    severity: 'warning',
    enabled: true,
  },
  {
    metricKey: 'evap_temp_c',
    mode: 'defrost',
    minValue: -28,
    maxValue: 8,
    hysteresis: 1,
    debounceCycles: 6,
    severity: 'info',
    enabled: true,
  },
];

/** Уставки счётчика: напряжение по допуску сети, ток и мощность по пределу ввода. */
const pm3PhaseRules: readonly ProfileAlarmRule[] = [
  ...perPhase((phase) => `voltage_${phase}_v`, {
    mode: 'cooling',
    minValue: 207,
    maxValue: 243,
    hysteresis: 2,
    debounceCycles: 3,
    severity: 'warning',
    enabled: true,
  }),
  ...perPhase((phase) => `current_${phase}_a`, {
    mode: 'cooling',
    minValue: null,
    maxValue: 70,
    hysteresis: 2,
    debounceCycles: 3,
    severity: 'warning',
    enabled: true,
  }),
  {
    metricKey: 'active_power_kw',
    mode: 'cooling',
    minValue: null,
    maxValue: 48,
    hysteresis: 1,
    debounceCycles: 3,
    severity: 'info',
    enabled: true,
  },
  {
    metricKey: 'power_factor',
    mode: 'cooling',
    minValue: 0.65,
    maxValue: null,
    hysteresis: 0.02,
    debounceCycles: 6,
    severity: 'info',
    enabled: true,
  },
];

/**
 * Уставки стенда по моделям приборов. Это стартовые значения: оператор правит их
 * в интерфейсе, и повторный перенос стенда его правки не затирает.
 */
export const DEFAULT_ALARM_RULES: Readonly<Record<string, readonly ProfileAlarmRule[]>> =
  Object.freeze({
    [rc2000Profile.profileKey]: rc2000Rules,
    [pm3PhaseProfile.profileKey]: pm3PhaseRules,
  });
