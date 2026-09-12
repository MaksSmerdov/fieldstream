import type pg from 'pg';
import type { Quality } from '@fieldstream/contracts';

/** Качество значения в таблице: код, а не строка, чтобы строка телеметрии оставалась узкой. */
export const QUALITY_CODE = Object.freeze({ ok: 0, stale: 1, substituted: 2, bad: 3 });

const QUALITY_NAME: readonly Quality[] = ['ok', 'stale', 'substituted', 'bad'];

/** Обратный разбор кода качества: слово и код живут рядом, поэтому разъехаться им негде. */
export const qualityOf = (code: number): Quality => QUALITY_NAME[code] ?? 'bad';

export interface ReadingRow {
  readonly ts: string;
  readonly deviceId: number;
  readonly metricKey: string;
  readonly value: number | null;
  readonly quality: number;
}

export interface PollCycleRow {
  readonly ts: string;
  readonly lineId: number;
  readonly deviceId: number;
  readonly ok: boolean;
  readonly errorKind: string | null;
  readonly durationMs: number;
  readonly requestCount: number;
  readonly planMode: string;
}

/**
 * Пачка показаний одним запросом через unnest. Повторная доставка той же пачки
 * ничего не добавляет: ключ идемпотентности это уникальный индекс (прибор, метрика, время).
 * Возвращает число реально вставленных строк.
 */
export const insertReadings = async (
  client: pg.ClientBase,
  rows: readonly ReadingRow[],
): Promise<number> => {
  if (rows.length === 0) return 0;

  const result = await client.query(
    `INSERT INTO ts.readings (ts, device_id, metric_key, value, quality)
     SELECT * FROM unnest($1::timestamptz[], $2::int[], $3::text[], $4::float8[], $5::smallint[])
     ON CONFLICT DO NOTHING`,
    [
      rows.map((row) => row.ts),
      rows.map((row) => row.deviceId),
      rows.map((row) => row.metricKey),
      rows.map((row) => row.value),
      rows.map((row) => row.quality),
    ],
  );
  return result.rowCount ?? 0;
};

/** Пачка итогов опроса. Ключ идемпотентности (прибор, время). */
export const insertPollCycles = async (
  client: pg.ClientBase,
  rows: readonly PollCycleRow[],
): Promise<number> => {
  if (rows.length === 0) return 0;

  const result = await client.query(
    `INSERT INTO ts.poll_cycles
       (ts, line_id, device_id, ok, error_kind, duration_ms, request_count, plan_mode)
     SELECT * FROM unnest($1::timestamptz[], $2::smallint[], $3::int[], $4::bool[], $5::text[],
                          $6::int[], $7::smallint[], $8::text[])
     ON CONFLICT DO NOTHING`,
    [
      rows.map((row) => row.ts),
      rows.map((row) => row.lineId),
      rows.map((row) => row.deviceId),
      rows.map((row) => row.ok),
      rows.map((row) => row.errorKind),
      rows.map((row) => row.durationMs),
      rows.map((row) => row.requestCount),
      rows.map((row) => row.planMode),
    ],
  );
  return result.rowCount ?? 0;
};
