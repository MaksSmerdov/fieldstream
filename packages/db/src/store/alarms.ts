import type pg from 'pg';
import type { AlarmRule, DeviceMode, Severity } from '@fieldstream/contracts';
import type { ProfileAlarmRule } from '@fieldstream/device-profiles';

/** Подъём аларма: строка эпизода, которую позже закроет снятие. */
export interface AlarmEventRow {
  readonly alarmId: string;
  readonly deviceId: number;
  readonly metricKey: string;
  readonly mode: DeviceMode;
  readonly severity: Severity;
  readonly boundary: 'min' | 'max';
  readonly value: number | null;
  readonly threshold: number | null;
  readonly occurredAt: string;
  readonly dedupeKey: string;
}

/** Снятие аларма: закрывает строку своего подъёма по ключу эпизода. */
export interface AlarmClearRow {
  readonly dedupeKey: string;
  readonly clearedAt: string;
  readonly clearedValue: number | null;
}

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

/**
 * Подъёмы алармов одной пачкой. Повторная доставка ничего не добавляет: ключ эпизода
 * уникален, а идентификатор вычислен из него же, поэтому строка совпадает с прежней.
 */
export const insertAlarmEvents = async (
  client: pg.ClientBase,
  rows: readonly AlarmEventRow[],
): Promise<number> => {
  if (rows.length === 0) return 0;

  const result = await client.query(
    `INSERT INTO core.alarm_events (id, device_id, metric_key, mode, severity, boundary,
       value, threshold, occurred_at, dedupe_key)
     SELECT * FROM unnest($1::uuid[], $2::int[], $3::text[], $4::text[], $5::text[], $6::text[],
       $7::float8[], $8::float8[], $9::timestamptz[], $10::text[])
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      rows.map((row) => row.alarmId),
      rows.map((row) => row.deviceId),
      rows.map((row) => row.metricKey),
      rows.map((row) => row.mode),
      rows.map((row) => row.severity),
      rows.map((row) => row.boundary),
      rows.map((row) => row.value),
      rows.map((row) => row.threshold),
      rows.map((row) => row.occurredAt),
      rows.map((row) => row.dedupeKey),
    ],
  );
  return result.rowCount ?? 0;
};

/** Снятия алармов одной пачкой. Уже закрытый эпизод второй раз не трогается. */
export const clearAlarmEvents = async (
  client: pg.ClientBase,
  rows: readonly AlarmClearRow[],
): Promise<number> => {
  if (rows.length === 0) return 0;

  const result = await client.query(
    `UPDATE core.alarm_events e
     SET cleared_at = c.cleared_at, cleared_value = c.cleared_value
     FROM unnest($1::text[], $2::timestamptz[], $3::float8[])
       AS c(dedupe_key, cleared_at, cleared_value)
     WHERE e.dedupe_key = c.dedupe_key AND e.cleared_at IS NULL`,
    [
      rows.map((row) => row.dedupeKey),
      rows.map((row) => row.clearedAt),
      rows.map((row) => row.clearedValue),
    ],
  );
  return result.rowCount ?? 0;
};

export interface OpenAlarmEpisode {
  readonly deviceCode: string;
  readonly metricKey: string;
  readonly mode: DeviceMode;
  readonly boundary: 'min' | 'max';
  readonly severity: Severity;
  readonly threshold: number | null;
  readonly raisedAtMs: number;
}

/**
 * Незакрытые эпизоды из базы. Состояние алармов живёт в памяти процессора, и без восстановления
 * перезапуск оставил бы открытые эпизоды сиротами.
 */
export const loadOpenAlarmEpisodes = async (client: pg.ClientBase): Promise<OpenAlarmEpisode[]> => {
  const result = await client.query<{
    device_code: string;
    metric_key: string;
    mode: DeviceMode;
    boundary: 'min' | 'max';
    severity: Severity;
    threshold: number | null;
    occurred_at: Date;
  }>(
    `SELECT d.code AS device_code, e.metric_key, e.mode, e.boundary, e.severity,
            e.threshold, e.occurred_at
     FROM core.alarm_events e JOIN core.devices d ON d.id = e.device_id
     WHERE e.cleared_at IS NULL
     ORDER BY e.occurred_at`,
  );

  return result.rows.map((row) => ({
    deviceCode: row.device_code,
    metricKey: row.metric_key,
    mode: row.mode,
    boundary: row.boundary,
    severity: row.severity,
    threshold: row.threshold,
    raisedAtMs: row.occurred_at.getTime(),
  }));
};
