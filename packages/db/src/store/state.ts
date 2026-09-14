import type pg from 'pg';
import type {
  DeviceEvent,
  DeviceMode,
  DeviceState,
  HealthReason,
  HealthStatus,
} from '@fieldstream/contracts';

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

const HANDOVER_LOCK = 'fieldstream.device-state.handover';

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

/**
 * Блокировка переезда состояния приборов до конца текущей транзакции. Проверка здоровья пишет
 * под общей блокировкой, а новый владелец читает под исключительной, поэтому чтение не проскочит
 * мимо записи, которую прежний владелец уже начал. timeoutMs ограничивает ожидание в базе.
 */
export const lockDeviceStateHandover = async (
  client: pg.ClientBase,
  mode: 'publish' | 'adopt',
  timeoutMs?: number,
): Promise<void> => {
  if (timeoutMs !== undefined) {
    await client.query(`SELECT set_config('lock_timeout', $1, true)`, [`${String(timeoutMs)}ms`]);
  }
  await client.query(
    mode === 'publish'
      ? 'SELECT pg_advisory_xact_lock_shared(hashtext($1))'
      : 'SELECT pg_advisory_xact_lock(hashtext($1))',
    [HANDOVER_LOCK],
  );
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

/**
 * Последнее записанное состояние приборов по кодам. С него продолжает здоровье экземпляр,
 * которому партиция прибора досталась при ребалансе. Прибор без строки в ответ не попадает.
 */
export const loadDeviceStates = async (
  client: pg.ClientBase,
  deviceCodes: readonly string[],
): Promise<DeviceState[]> => {
  if (deviceCodes.length === 0) return [];

  const result = await client.query<{
    device_code: string;
    status: HealthStatus;
    reason: HealthReason;
    since: Date;
    mode: DeviceMode;
    last_ok_at: Date | null;
    consecutive_errors: number;
  }>(
    `SELECT d.code AS device_code, s.status, s.reason, s.since, s.mode, s.last_ok_at,
            s.consecutive_errors
     FROM core.device_state s JOIN core.devices d ON d.id = s.device_id
     WHERE d.code = ANY($1::text[])
     ORDER BY d.code`,
    [[...deviceCodes]],
  );

  return result.rows.map((row) => ({
    schema: 'device.state',
    v: 1,
    deviceCode: row.device_code,
    status: row.status,
    reason: row.reason,
    since: row.since.toISOString(),
    mode: row.mode,
    lastOkAt: row.last_ok_at === null ? null : row.last_ok_at.toISOString(),
    consecutiveErrors: row.consecutive_errors,
  }));
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

/** Стадия готовности стенда: по ней интерфейс рисует загрузочную панель вместо пустых экранов. */
export interface BootStage {
  readonly stage: string;
  readonly status: 'pending' | 'running' | 'done' | 'failed';
  readonly progressPct?: number;
  readonly detail?: string;
}

export const updateBootStage = async (client: pg.ClientBase, stage: BootStage): Promise<void> => {
  await client.query(
    `INSERT INTO core.boot_progress (stage, status, detail, progress_pct, started_at, finished_at,
       updated_at)
     VALUES ($1, $2, $3, $4,
       CASE WHEN $2 = 'running' THEN now() END,
       CASE WHEN $2 IN ('done', 'failed') THEN now() END,
       now())
     ON CONFLICT (stage) DO UPDATE
     SET status = EXCLUDED.status,
         detail = coalesce(EXCLUDED.detail, core.boot_progress.detail),
         progress_pct = EXCLUDED.progress_pct,
         started_at = coalesce(core.boot_progress.started_at, EXCLUDED.started_at),
         finished_at = EXCLUDED.finished_at,
         updated_at = now()`,
    [stage.stage, stage.status, stage.detail ?? null, stage.progressPct ?? 0],
  );
};
