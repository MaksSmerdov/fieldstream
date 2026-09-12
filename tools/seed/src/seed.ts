import type pg from 'pg';
import { alarmDedupeKey, alarmIdOf } from '@fieldstream/domain';
import { DEVICE_PROFILES } from '@fieldstream/device-profiles';
import { INCIDENTS, wavesOf } from './history.js';
import type { Incident } from './history.js';

export interface SeedOptions {
  readonly days: number;
  /** Конец окна засева. Внутри выравнивается по часу, иначе повтор даёт вторую историю рядом. */
  readonly until: Date;
  readonly onProgress?: (stage: string, done: number, total: number) => void;
}

export interface SeedReport {
  readonly readings: number;
  readonly alarms: number;
  readonly from: string;
  readonly to: string;
}

/**
 * Засев истории. Строки не едут по сети: их порождает сама база из generate_series,
 * поэтому двухмиллионная неделя укладывается в минуты, а не в час. Повтор ничего не добавляет,
 * ключ идемпотентности это уникальный индекс телеметрии.
 */
export const seedHistory = async (
  client: pg.ClientBase,
  options: SeedOptions,
): Promise<SeedReport> => {
  const to = new Date(Math.floor(options.until.getTime() / 3_600_000) * 3_600_000);
  const from = new Date(to.getTime() - options.days * 86_400_000);

  await client.query('SET LOCAL synchronous_commit = off');

  let readings = 0;
  const waves = DEVICE_PROFILES.flatMap((profile) =>
    wavesOf(profile).map((wave) => ({ profileKey: profile.profileKey, wave })),
  );

  for (const [index, item] of waves.entries()) {
    const { wave } = item;
    const value = wave.monotonic
      ? `${String(wave.center)} + extract(epoch from g.ts - $4::timestamptz) / 36.0`
      : `${String(wave.center)} + ${String(wave.amplitude)} * ` +
        `sin(2 * pi() * (extract(epoch from g.ts) / ${String(wave.periodSec)} + ` +
        `${String(wave.phase)} + d.id::float8 / 24))`;

    const result = await client.query(
      `INSERT INTO ts.readings (ts, device_id, metric_key, value, quality)
       SELECT g.ts, d.id, $1, round((${value})::numeric, $5)::float8, 0
       FROM generate_series($3::timestamptz, $4::timestamptz, INTERVAL '1 minute') AS g(ts)
       CROSS JOIN core.devices d
       WHERE d.profile_key = $2
       ON CONFLICT DO NOTHING`,
      [wave.metricKey, item.profileKey, from.toISOString(), to.toISOString(), wave.precision],
    );

    readings += result.rowCount ?? 0;
    options.onProgress?.('readings', index + 1, waves.length);
  }

  const alarms = await seedIncidents(client, to);

  return { readings, alarms, from: from.toISOString(), to: to.toISOString() };
};

/** Окно происшествия в истории: значения за уставкой плюс сам эпизод аларма. */
const seedIncidents = async (client: pg.ClientBase, to: Date): Promise<number> => {
  let written = 0;

  for (const incident of INCIDENTS) {
    const startedAt = new Date(to.getTime() - incident.hoursAgo * 3_600_000);
    const endedAt = new Date(startedAt.getTime() + incident.durationMin * 60_000);

    await client.query(
      `UPDATE ts.readings r
       SET value = $4
       FROM core.devices d
       WHERE d.id = r.device_id AND d.code = $1 AND r.metric_key = $2
         AND r.ts >= $3::timestamptz AND r.ts < $5::timestamptz`,
      [
        incident.deviceCode,
        incident.metricKey,
        startedAt.toISOString(),
        incident.value,
        endedAt.toISOString(),
      ],
    );

    written += await insertIncidentAlarm(client, incident, startedAt, endedAt);
  }

  return written;
};

/** Эпизод аларма с тем же ключом, который дал бы движок: история и живой поток сравнимы. */
const insertIncidentAlarm = async (
  client: pg.ClientBase,
  incident: Incident,
  startedAt: Date,
  endedAt: Date,
): Promise<number> => {
  const dedupeKey = alarmDedupeKey({
    deviceCode: incident.deviceCode,
    metricKey: incident.metricKey,
    mode: 'cooling',
    raisedAt: startedAt.getTime(),
  });

  const result = await client.query(
    `INSERT INTO core.alarm_events (id, device_id, metric_key, mode, severity, boundary,
       value, threshold, occurred_at, cleared_at, cleared_value, dedupe_key)
     SELECT $1::uuid, d.id, $3, 'cooling', $4, $5, $6, $7, $8, $9, $10, $11
     FROM core.devices d WHERE d.code = $2
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      alarmIdOf(dedupeKey),
      incident.deviceCode,
      incident.metricKey,
      incident.severity,
      incident.boundary,
      incident.value,
      incident.threshold,
      startedAt.toISOString(),
      endedAt.toISOString(),
      incident.threshold,
      dedupeKey,
    ],
  );

  return result.rowCount ?? 0;
};

/**
 * Пересчёт агрегатов на засеянном окне. Без него длинные графики пусты: непрерывные
 * агрегаты сами догоняют только свежие данные, а не залитую задним числом неделю.
 */
export const refreshAggregates = async (
  client: pg.ClientBase,
  from: string,
  to: string,
): Promise<void> => {
  await client.query(
    `CALL refresh_continuous_aggregate('ts.readings_1m', $1::timestamptz, $2::timestamptz)`,
    [from, to],
  );
  await client.query(
    `CALL refresh_continuous_aggregate('ts.readings_1h', $1::timestamptz, $2::timestamptz)`,
    [from, to],
  );
};

export interface CompressionReport {
  readonly chunks: number;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly ratio: number;
}

/**
 * Сжатие старых кусков и замер. Политика сжимает данные старше двух суток сама, но по
 * расписанию: на засеянной неделе это делается руками, иначе цифру в README взять негде.
 * Меряется по самим сжатым кускам, а не по всей гипертаблице: горячие сутки и индексы
 * в общем размере занизили бы коэффициент вдвое и цифра ничего бы не значила.
 */
export const compressHistory = async (client: pg.ClientBase): Promise<CompressionReport> => {
  await client.query(
    `SELECT compress_chunk(chunk, if_not_compressed => true)
     FROM show_chunks('ts.readings', older_than => INTERVAL '2 days') chunk`,
  );

  const stats = await client.query<{ chunks: string; before: string; after: string }>(
    `SELECT count(*)::text AS chunks,
            coalesce(sum(before_compression_total_bytes), 0)::text AS before,
            coalesce(sum(after_compression_total_bytes), 0)::text AS after
     FROM chunk_compression_stats('ts.readings')
     WHERE compression_status = 'Compressed'`,
  );
  const row = stats.rows[0];
  const before = Number(row?.before ?? 0);
  const after = Number(row?.after ?? 0);

  return {
    chunks: Number(row?.chunks ?? 0),
    beforeBytes: before,
    afterBytes: after,
    ratio: after === 0 ? 0 : Number((before / after).toFixed(2)),
  };
};
