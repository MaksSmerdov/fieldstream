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
  readonly defrosts: number;
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
  const edge = await historyEdge(client, to);

  await client.query('SET LOCAL synchronous_commit = off');
  // Правки задевают уже сжатые куски: при повторном засеве строку в сжатом сегменте нельзя
  // изменить, не распаковав сегмент целиком, а предел по умолчанию это сто тысяч строк на
  // транзакцию. Для разовой заливки задним числом предел снимается, иначе засев падает на
  // середине с сообщением про лимит распаковки.
  await client.query('SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0');

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
      [wave.metricKey, item.profileKey, from.toISOString(), edge.toISOString(), wave.precision],
    );

    readings += result.rowCount ?? 0;
    options.onProgress?.('readings', index + 1, waves.length);
  }

  const defrosts = await seedDefrosts(client, from, edge);
  const alarms = await seedIncidents(client, edge);

  return { readings, alarms, defrosts, from: from.toISOString(), to: edge.toISOString() };
};

/**
 * Докуда засевать. Живые данные уже лежащие в базе перекрывать нельзя: у засева своя волна,
 * у опроса свои значения, и на графике получились бы две правды об одном часе сразу.
 */
const historyEdge = async (client: pg.ClientBase, to: Date): Promise<Date> => {
  const result = await client.query<{ at: Date | null }>('SELECT min(ts) AS at FROM ts.readings');
  const earliest = result.rows[0]?.at ?? null;

  return earliest === null || earliest.getTime() > to.getTime() ? to : earliest;
};

/** Оттайка раз в шесть часов и сколько она длится: полоса режимов на экране рисуется по этим событиям. */
const DEFROST_PERIOD_HOURS = 6;
const DEFROST_MINUTES = 20;

/**
 * Оттайки в истории. Без них полоса режимов на графике была бы ровной, а подъём температуры
 * испарителя нечем объяснить: событие и сами значения ставятся вместе, иначе полоса и кривая
 * рассказывали бы об одном часе разное. Значения правятся только на окнах, созданных этим же
 * запуском: иначе повторный засев поднимал бы температуру второй раз поверх первой.
 */
const seedDefrosts = async (client: pg.ClientBase, from: Date, to: Date): Promise<number> => {
  const startedAt = `g.ts + make_interval(hours => (d.id % ${String(DEFROST_PERIOD_HOURS)})::int)`;
  const window = `INTERVAL '${String(DEFROST_MINUTES)} minutes'`;

  const change = async (
    at: string,
    fromMode: string,
    toMode: string,
  ): Promise<{ deviceId: number; startedAt: Date }[]> => {
    const result = await client.query<{ device_id: number; occurred_at: Date }>(
      `INSERT INTO core.device_events (device_id, kind, payload, occurred_at)
       SELECT d.id, 'mode_changed', jsonb_build_object('from', $3::text, 'to', $4::text), ${at}
       FROM generate_series($1::timestamptz, $2::timestamptz,
                            INTERVAL '${String(DEFROST_PERIOD_HOURS)} hours') AS g(ts)
       CROSS JOIN core.devices d
       WHERE d.profile_key = 'rc-2000' AND ${at} < $2::timestamptz
       ON CONFLICT DO NOTHING
       RETURNING device_id, occurred_at`,
      [from.toISOString(), to.toISOString(), fromMode, toMode],
    );

    return result.rows.map((row) => ({ deviceId: row.device_id, startedAt: row.occurred_at }));
  };

  const started = await change(startedAt, 'cooling', 'defrost');
  await change(`${startedAt} + ${window}`, 'defrost', 'cooling');
  if (started.length === 0) return 0;

  await client.query(
    `UPDATE ts.readings r
     SET value = round((r.value + CASE r.metric_key
           WHEN 'evap_temp_c' THEN 7.0 ELSE 2.5 END)::numeric, 1)::float8
     FROM unnest($1::int[], $2::timestamptz[]) AS w(device_id, started_at)
     WHERE r.device_id = w.device_id AND r.metric_key IN ('evap_temp_c', 'supply_temp_c')
       AND r.ts >= w.started_at AND r.ts < w.started_at + ${window}`,
    [started.map((item) => item.deviceId), started.map((item) => item.startedAt.toISOString())],
  );

  return started.length;
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
 * Повторный засев не добавляет строк и отдаёт пустое окно, на котором TimescaleDB
 * обновлять агрегат отказывается. Возвращает, был ли пересчёт.
 */
export const refreshAggregates = async (
  client: pg.ClientBase,
  from: string,
  to: string,
): Promise<boolean> => {
  if (Date.parse(from) >= Date.parse(to)) return false;

  await client.query(
    `CALL refresh_continuous_aggregate('ts.readings_1m', $1::timestamptz, $2::timestamptz)`,
    [from, to],
  );
  await client.query(
    `CALL refresh_continuous_aggregate('ts.readings_1h', $1::timestamptz, $2::timestamptz)`,
    [from, to],
  );

  return true;
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
