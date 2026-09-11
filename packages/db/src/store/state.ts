import type pg from 'pg';
import type { DeviceEvent, DeviceState } from '@fieldstream/contracts';

export interface DeviceStateRow {
  readonly deviceId: number;
  readonly state: DeviceState;
  readonly updatedAt: string;
}

export interface DeviceEventRow {
  readonly deviceId: number;
  readonly event: DeviceEvent;
}

export interface DlqRow {
  readonly sourceTopic: string;
  readonly partition: number;
  readonly offset: string;
  readonly key: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: Buffer | null;
  readonly errorClass: string;
  readonly error: string;
}

/** Работа в одной транзакции на отдельном соединении пула. Сломанное соединение в пул не возвращается. */
export const withTransaction = async <T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  let broken = false;

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    broken = true;
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release(broken);
  }
};

/** Последнее состояние приборов: одна строка на прибор, перезаписывается целиком. */
export const upsertDeviceStates = async (
  client: pg.ClientBase,
  rows: readonly DeviceStateRow[],
): Promise<void> => {
  if (rows.length === 0) return;

  await client.query(
    `INSERT INTO core.device_state
       (device_id, status, reason, since, mode, last_ok_at, consecutive_errors, updated_at)
     SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::timestamptz[], $5::text[],
                          $6::timestamptz[], $7::int[], $8::timestamptz[])
     ON CONFLICT (device_id) DO UPDATE
     SET status = EXCLUDED.status, reason = EXCLUDED.reason, since = EXCLUDED.since,
         mode = EXCLUDED.mode, last_ok_at = EXCLUDED.last_ok_at,
         consecutive_errors = EXCLUDED.consecutive_errors, updated_at = EXCLUDED.updated_at`,
    [
      rows.map((row) => row.deviceId),
      rows.map((row) => row.state.status),
      rows.map((row) => row.state.reason),
      rows.map((row) => row.state.since),
      rows.map((row) => row.state.mode),
      rows.map((row) => row.state.lastOkAt),
      rows.map((row) => row.state.consecutiveErrors),
      rows.map((row) => row.updatedAt),
    ],
  );
};

/** События приборов. Повтор того же события ничего не добавляет: ключ (прибор, вид, момент). */
export const insertDeviceEvents = async (
  client: pg.ClientBase,
  rows: readonly DeviceEventRow[],
): Promise<number> => {
  if (rows.length === 0) return 0;

  const result = await client.query(
    `INSERT INTO core.device_events (device_id, kind, payload, occurred_at)
     SELECT * FROM unnest($1::int[], $2::text[], $3::jsonb[], $4::timestamptz[])
     ON CONFLICT DO NOTHING`,
    [
      rows.map((row) => row.deviceId),
      rows.map((row) => row.event.kind),
      rows.map((row) => JSON.stringify(row.event.payload)),
      rows.map((row) => row.event.occurredAt),
    ],
  );
  return result.rowCount ?? 0;
};

/** Сообщения, ушедшие в очередь недоставленных: по этой таблице их находит интерфейс. */
export const recordDlqMessages = async (
  client: pg.ClientBase,
  rows: readonly DlqRow[],
): Promise<void> => {
  for (const row of rows) {
    await client.query(
      `INSERT INTO core.dlq_message (source_topic, partition, "offset", key, headers, payload, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source_topic, partition, "offset") DO NOTHING`,
      [
        row.sourceTopic,
        row.partition,
        row.offset,
        row.key,
        JSON.stringify(row.headers),
        row.payload,
        JSON.stringify({ class: row.errorClass, message: row.error }),
      ],
    );
  }
};
