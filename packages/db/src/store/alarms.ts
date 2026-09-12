import type pg from 'pg';
import type { AlarmRule, DeviceMode, Severity } from '@fieldstream/contracts';
import type { ProfileAlarmRule } from '@fieldstream/device-profiles';

interface AlarmRuleRow {
  readonly device_code: string;
  readonly metric_key: string;
  readonly mode: DeviceMode;
  readonly min_value: number | null;
  readonly max_value: number | null;
  readonly hysteresis: number;
  readonly debounce_cycles: number;
  readonly severity: Severity;
  readonly enabled: boolean;
}

/**
 * Переносит стартовые уставки моделей на приборы. Уже заведённая уставка не трогается:
 * значения, поправленные оператором, живут своей жизнью и перезапуск стенда их не возвращает.
 */
export const syncAlarmRules = async (
  client: pg.ClientBase,
  defaults: Readonly<Record<string, readonly ProfileAlarmRule[]>>,
): Promise<number> => {
  let inserted = 0;

  for (const [profileKey, rules] of Object.entries(defaults)) {
    for (const rule of rules) {
      const result = await client.query(
        `INSERT INTO core.alarm_rules (device_id, metric_key, mode, min_value, max_value,
           hysteresis, debounce_cycles, severity, enabled, updated_by)
         SELECT d.id, $2, $3, $4, $5, $6, $7, $8, $9, 'stand'
         FROM core.devices d WHERE d.profile_key = $1
         ON CONFLICT (device_id, metric_key, mode) DO NOTHING`,
        [
          profileKey,
          rule.metricKey,
          rule.mode,
          rule.minValue,
          rule.maxValue,
          rule.hysteresis,
          rule.debounceCycles,
          rule.severity,
          rule.enabled,
        ],
      );
      inserted += result.rowCount ?? 0;
    }
  }

  return inserted;
};

/** Уставки всех приборов для движка алармов: ключ уставки это прибор, метрика и режим. */
export const loadAlarmRules = async (client: pg.ClientBase): Promise<AlarmRule[]> => {
  const result = await client.query<AlarmRuleRow>(
    `SELECT d.code AS device_code, r.metric_key, r.mode, r.min_value, r.max_value,
            r.hysteresis, r.debounce_cycles, r.severity, r.enabled
     FROM core.alarm_rules r JOIN core.devices d ON d.id = r.device_id
     WHERE r.enabled
     ORDER BY d.code, r.metric_key, r.mode`,
  );

  return result.rows.map((row) => ({
    deviceCode: row.device_code,
    metricKey: row.metric_key,
    mode: row.mode,
    minValue: row.min_value,
    maxValue: row.max_value,
    hysteresis: row.hysteresis,
    debounceCycles: row.debounce_cycles,
    severity: row.severity,
    enabled: row.enabled,
  }));
};
