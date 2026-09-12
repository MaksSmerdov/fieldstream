import type pg from 'pg';

/** Строка очереди, готовая к отправке. */
export interface OutboxRow {
  readonly id: string;
  readonly topic: string;
  readonly msgKey: string;
  readonly payload: unknown;
  readonly attempts: number;
}

export interface OutboxEntry {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly revision: number;
  readonly topic: string;
  readonly msgKey: string;
  readonly payload: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Кладёт сообщение в очередь исходящих. Ложь означает, что такая ревизия уже лежит:
 * повторная отправка той же команды ничего не дублирует.
 */
export const enqueueOutbox = async (
  client: pg.ClientBase,
  entry: OutboxEntry,
): Promise<boolean> => {
  const result = await client.query(
    `INSERT INTO core.outbox (aggregate_type, aggregate_id, revision, topic, msg_key, payload, headers)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (aggregate_id, revision) DO NOTHING`,
    [
      entry.aggregateType,
      entry.aggregateId,
      entry.revision,
      entry.topic,
      entry.msgKey,
      JSON.stringify(entry.payload),
      JSON.stringify(entry.headers ?? {}),
    ],
  );

  return (result.rowCount ?? 0) > 0;
};

/**
 * Забирает пачку готовых строк. SKIP LOCKED позволяет нескольким экземплярам шлюза
 * разбирать очередь параллельно, не наступая друг на друга и не дожидаясь чужих блокировок.
 */
export const claimOutbox = async (
  client: pg.ClientBase,
  lockId: string,
  limit: number,
): Promise<OutboxRow[]> => {
  const result = await client.query<{
    id: string;
    topic: string;
    msg_key: string;
    payload: unknown;
    attempts: number;
  }>(
    `UPDATE core.outbox SET lock_id = $1, locked_at = now(), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM core.outbox
       WHERE published_at IS NULL AND next_attempt_at <= now()
       ORDER BY id LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, topic, msg_key, payload, attempts`,
    [lockId, limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    topic: row.topic,
    msgKey: row.msg_key,
    payload: row.payload,
    attempts: row.attempts,
  }));
};

/** Отмечает отправленное. Повторная публикация безвредна: приёмник гасит дубли по ключу. */
export const markOutboxPublished = async (
  client: pg.ClientBase,
  ids: readonly string[],
  publishedAt: string,
): Promise<void> => {
  if (ids.length === 0) return;

  await client.query(
    `UPDATE core.outbox SET published_at = $2, lock_id = NULL, locked_at = NULL
     WHERE id = ANY($1::bigint[])`,
    [ids, publishedAt],
  );
};

/** Откладывает неудачную отправку: следующая попытка не раньше указанного времени. */
export const markOutboxFailed = async (
  client: pg.ClientBase,
  ids: readonly string[],
  error: string,
  nextAttemptAt: string,
): Promise<void> => {
  if (ids.length === 0) return;

  await client.query(
    `UPDATE core.outbox SET last_error = $2, next_attempt_at = $3, lock_id = NULL, locked_at = NULL
     WHERE id = ANY($1::bigint[])`,
    [ids, error.slice(0, 500), nextAttemptAt],
  );
};

/** Где сейчас команда: ждёт отправки, уже в топике или применена исполнителем. */
export interface CommandProgress {
  readonly commandId: string;
  readonly stage: 'queued' | 'sent' | 'applied' | 'rejected' | 'expired';
  readonly issuedAt: string;
  readonly publishedAt: string | null;
  readonly appliedAt: string | null;
  readonly attempts: number;
  readonly detail: string | null;
}

interface ProgressRow {
  readonly created_at: Date;
  readonly published_at: Date | null;
  readonly attempts: number;
  readonly applied_at: Date | null;
  readonly result: { status?: string; detail?: string } | null;
}

export const loadCommandProgress = async (
  client: pg.ClientBase,
  commandId: string,
): Promise<CommandProgress | null> => {
  const result = await client.query<ProgressRow>(
    `SELECT o.created_at, o.published_at, o.attempts, a.applied_at, a.result
     FROM core.outbox o
     LEFT JOIN core.applied_commands a ON a.command_id = o.aggregate_id::uuid
     WHERE o.aggregate_type = 'command' AND o.aggregate_id = $1`,
    [commandId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;

  const status = row.result?.status;
  const stage =
    row.applied_at !== null &&
    (status === 'applied' || status === 'rejected' || status === 'expired')
      ? status
      : row.published_at === null
        ? 'queued'
        : 'sent';

  return {
    commandId,
    stage,
    issuedAt: row.created_at.toISOString(),
    publishedAt: row.published_at === null ? null : row.published_at.toISOString(),
    appliedAt: row.applied_at === null ? null : row.applied_at.toISOString(),
    attempts: row.attempts,
    detail: row.result?.detail ?? null,
  };
};

export interface AppliedCommandRow {
  readonly commandId: string;
  readonly lineCode: string;
  readonly kind: string;
  readonly args: unknown;
  readonly appliedAt: string;
  readonly result: unknown;
}

/** Факт применения команды. Пишет его процессор, прочитав ответ исполнителя из брокера. */
export const recordAppliedCommand = async (
  client: pg.ClientBase,
  row: AppliedCommandRow,
): Promise<boolean> => {
  const result = await client.query(
    `INSERT INTO core.applied_commands (command_id, line_id, kind, args, applied_at, result)
     SELECT $1::uuid, l.id, $3, $4, $5, $6 FROM core.lines l WHERE l.code = $2
     ON CONFLICT (command_id) DO NOTHING`,
    [
      row.commandId,
      row.lineCode,
      row.kind,
      JSON.stringify(row.args),
      row.appliedAt,
      JSON.stringify(row.result),
    ],
  );

  return (result.rowCount ?? 0) > 0;
};
