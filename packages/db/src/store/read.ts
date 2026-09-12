import type pg from 'pg';
import type {
  DeviceSnapshot,
  SeriesMetric,
  SeriesSource,
  Severity,
  TopologySite,
} from '@fieldstream/contracts';
import { qualityOf } from './writer.js';

interface TopologyRow {
  readonly site_code: string;
  readonly site_name: string;
  readonly timezone: string;
  readonly gateway_code: string;
  readonly host: string;
  readonly line_code: string;
  readonly baud: number;
  readonly poll_interval_ms: number;
  readonly request_timeout_ms: number;
  readonly plan_mode: 'merged' | 'naive';
  readonly line_enabled: boolean;
  readonly device_code: string;
  readonly label: string;
  readonly profile_key: string;
  readonly profile_version: number;
  readonly slave_id: number;
  readonly device_enabled: boolean;
  readonly status: DeviceSnapshot['status'] | null;
  readonly reason: DeviceSnapshot['reason'] | null;
  readonly mode: DeviceSnapshot['mode'] | null;
  readonly since: Date | null;
  readonly last_ok_at: Date | null;
  readonly active_alarms: string;
  readonly worst: number | null;
}

/** Незакрытые алармы прибора: счётчик и худшая важность одним подзапросом. */
const ACTIVE_ALARMS = `
  SELECT device_id, count(*) AS active,
         max(CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END) AS worst
  FROM core.alarm_events WHERE cleared_at IS NULL GROUP BY device_id`;

const SEVERITY_BY_RANK: Readonly<Record<number, Severity>> = {
  1: 'info',
  2: 'warning',
  3: 'critical',
};

const isoOrNull = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

/**
 * Дерево объектов целиком: площадка, шлюз, линия, прибор вместе с состоянием и счётчиком
 * алармов. Один запрос, а не запрос на узел: на двадцати четырёх приборах это уже заметно.
 */
export const loadTopologyTree = async (client: pg.ClientBase): Promise<TopologySite[]> => {
  const result = await client.query<TopologyRow>(
    `SELECT s.code AS site_code, s.name AS site_name, s.timezone,
            g.code AS gateway_code, g.host,
            l.code AS line_code, l.baud, l.poll_interval_ms, l.request_timeout_ms,
            l.plan_mode, l.enabled AS line_enabled,
            d.code AS device_code, d.label, d.profile_key, d.profile_version, d.slave_id,
            d.enabled AS device_enabled,
            st.status, st.reason, st.mode, st.since, st.last_ok_at,
            coalesce(a.active, 0) AS active_alarms, a.worst
     FROM core.sites s
     JOIN core.gateways g ON g.site_id = s.id
     JOIN core.lines l ON l.gateway_id = g.id
     JOIN core.devices d ON d.line_id = l.id
     LEFT JOIN core.device_state st ON st.device_id = d.id
     LEFT JOIN (${ACTIVE_ALARMS}) a ON a.device_id = d.id
     ORDER BY s.code, g.code, l.code, d.code`,
  );

  const sites = new Map<string, TopologySite>();

  for (const row of result.rows) {
    let site = sites.get(row.site_code);
    if (site === undefined) {
      site = { code: row.site_code, name: row.site_name, timezone: row.timezone, gateways: [] };
      sites.set(row.site_code, site);
    }

    let gateway = site.gateways.find((item) => item.code === row.gateway_code);
    if (gateway === undefined) {
      gateway = { code: row.gateway_code, host: row.host, lines: [] };
      site.gateways.push(gateway);
    }

    let line = gateway.lines.find((item) => item.code === row.line_code);
    if (line === undefined) {
      line = {
        code: row.line_code,
        baud: row.baud,
        pollIntervalMs: row.poll_interval_ms,
        requestTimeoutMs: row.request_timeout_ms,
        planMode: row.plan_mode,
        enabled: row.line_enabled,
        devices: [],
      };
      gateway.lines.push(line);
    }

    line.devices.push({
      code: row.device_code,
      label: row.label,
      profileKey: row.profile_key,
      profileVersion: row.profile_version,
      slaveId: row.slave_id,
      enabled: row.device_enabled,
      status: row.status ?? 'unknown',
      reason: row.reason ?? 'no_data',
      mode: row.mode ?? 'cooling',
      since: isoOrNull(row.since),
      lastOkAt: isoOrNull(row.last_ok_at),
      activeAlarms: Number(row.active_alarms),
      worstSeverity: row.worst === null ? null : (SEVERITY_BY_RANK[row.worst] ?? null),
    });
  }

  return [...sites.values()];
};

/** Снимок прибора до применения серверных часов: признак устаревания считает вызывающий. */
export type DeviceSnapshotData = Omit<DeviceSnapshot, 'stale' | 'serverTime'> & {
  readonly pollIntervalMs: number;
};

interface SnapshotRow {
  readonly device_id: number;
  readonly label: string;
  readonly line_code: string;
  readonly site_code: string;
  readonly profile_key: string;
  readonly profile_version: number;
  readonly poll_interval_ms: number;
  readonly status: DeviceSnapshot['status'] | null;
  readonly reason: DeviceSnapshot['reason'] | null;
  readonly mode: DeviceSnapshot['mode'] | null;
  readonly since: Date | null;
  readonly last_ok_at: Date | null;
  readonly consecutive_errors: number | null;
  readonly active_alarms: string;
}

interface MetricRow {
  readonly metric_key: string;
  readonly label: string;
  readonly unit: string | null;
  readonly kind: 'number' | 'enum' | 'bits';
  readonly precision: number;
  readonly value: number | null;
  readonly quality: number | null;
  readonly ts: Date | null;
}

/**
 * Последние значения прибора. Описание метрик приходит вместе с числами: интерфейсу
 * нужны единица и точность, а второй запрос за ними на каждый экран это лишний круг.
 */
export const loadDeviceSnapshot = async (
  client: pg.ClientBase,
  deviceCode: string,
): Promise<DeviceSnapshotData | null> => {
  const device = await client.query<SnapshotRow>(
    `SELECT d.id AS device_id, d.label, l.code AS line_code, s.code AS site_code,
            d.profile_key, d.profile_version, l.poll_interval_ms,
            st.status, st.reason, st.mode, st.since, st.last_ok_at, st.consecutive_errors,
            coalesce(a.active, 0) AS active_alarms
     FROM core.devices d
     JOIN core.lines l ON l.id = d.line_id
     JOIN core.gateways g ON g.id = l.gateway_id
     JOIN core.sites s ON s.id = g.site_id
     LEFT JOIN core.device_state st ON st.device_id = d.id
     LEFT JOIN (${ACTIVE_ALARMS}) a ON a.device_id = d.id
     WHERE d.code = $1`,
    [deviceCode],
  );
  const row = device.rows[0];
  if (row === undefined) return null;

  const metrics = await client.query<MetricRow>(
    `SELECT m.metric_key, m.label, m.unit, m.kind, m.precision,
            last.value, last.quality, last.ts
     FROM core.metric_defs m
     LEFT JOIN LATERAL (
       SELECT r.value, r.quality, r.ts FROM ts.readings r
       WHERE r.device_id = $1 AND r.metric_key = m.metric_key
         AND r.ts > now() - INTERVAL '2 hours'
       ORDER BY r.ts DESC LIMIT 1
     ) last ON true
     WHERE m.profile_key = $2
     ORDER BY m.metric_key`,
    [row.device_id, row.profile_key],
  );

  const latest = metrics.rows
    .map((metric) => metric.ts)
    .filter((ts): ts is Date => ts !== null)
    .sort((left, right) => right.getTime() - left.getTime())[0];

  return {
    deviceCode,
    label: row.label,
    lineCode: row.line_code,
    siteCode: row.site_code,
    profileKey: row.profile_key,
    profileVersion: row.profile_version,
    pollIntervalMs: row.poll_interval_ms,
    status: row.status ?? 'unknown',
    reason: row.reason ?? 'no_data',
    mode: row.mode ?? 'cooling',
    since: isoOrNull(row.since),
    lastOkAt: isoOrNull(row.last_ok_at),
    consecutiveErrors: row.consecutive_errors ?? 0,
    ts: latest === undefined ? null : latest.toISOString(),
    activeAlarms: Number(row.active_alarms),
    metrics: metrics.rows.map((metric) => ({
      metricKey: metric.metric_key,
      label: metric.label,
      unit: metric.unit,
      kind: metric.kind,
      precision: metric.precision,
      value: metric.value,
      quality: qualityOf(metric.quality ?? 3),
      ts: isoOrNull(metric.ts),
    })),
  };
};

export interface SeriesRequest {
  readonly deviceCode: string;
  readonly metricKeys: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly source: SeriesSource;
  readonly bucketMs: number;
}

interface SeriesRow {
  readonly bucket: Date;
  readonly metric_key: string;
  readonly avg: string | null;
  readonly min: string | null;
  readonly max: string | null;
  readonly n: string;
}

const numberOrNull = (value: string | null): number | null =>
  value === null ? null : Number(value);

/**
 * Серия в выбранном разрешении. Из сырых строк считается обычное среднее, из агрегатов
 * средневзвешенное по числу отсчётов: иначе редкие минуты весили бы столько же, сколько полные.
 */
export const loadSeries = async (
  client: pg.ClientBase,
  request: SeriesRequest,
): Promise<SeriesMetric[]> => {
  const bucket = `${String(request.bucketMs)} milliseconds`;
  const query =
    request.source === 'readings'
      ? `SELECT time_bucket($4::interval, r.ts) AS bucket, r.metric_key,
                avg(r.value) AS avg, min(r.value) AS min, max(r.value) AS max,
                count(r.value) AS n
         FROM ts.readings r
         JOIN core.devices d ON d.id = r.device_id
         WHERE d.code = $1 AND r.metric_key = ANY($2::text[]) AND r.ts >= $3 AND r.ts < $5
         GROUP BY 1, 2 ORDER BY 2, 1`
      : `SELECT time_bucket($4::interval, v.bucket) AS bucket, v.metric_key,
                sum(v.avg_value * v.n) / NULLIF(sum(v.n), 0) AS avg,
                min(v.min_value) AS min, max(v.max_value) AS max, sum(v.n) AS n
         FROM ts.${request.source === 'readings_1m' ? 'v_readings_1m' : 'v_readings_1h'} v
         JOIN core.devices d ON d.id = v.device_id
         WHERE d.code = $1 AND v.metric_key = ANY($2::text[]) AND v.bucket >= $3 AND v.bucket < $5
         GROUP BY 1, 2 ORDER BY 2, 1`;

  const result = await client.query<SeriesRow>(query, [
    request.deviceCode,
    [...request.metricKeys],
    request.from,
    bucket,
    request.to,
  ]);

  const byMetric = new Map<string, SeriesMetric>(
    request.metricKeys.map((metricKey) => [metricKey, { metricKey, points: [] }]),
  );

  for (const row of result.rows) {
    byMetric.get(row.metric_key)?.points.push({
      t: row.bucket.toISOString(),
      avg: numberOrNull(row.avg),
      min: numberOrNull(row.min),
      max: numberOrNull(row.max),
      n: Number(row.n),
    });
  }

  return [...byMetric.values()];
};
