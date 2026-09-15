import type pg from 'pg';
import type {
  DlqListQuery,
  DlqMessage,
  DlqRedrive,
  DlqRedriveStatus,
} from '@fieldstream/contracts';

export interface DlqCounts {
  readonly unresolved: number;
  readonly total: number;
}

/** Счёт очереди недоставленных: сколько ждёт разбора и сколько всего. Окончательно отвергнутые не ждут. */
export const loadDlqCounts = async (client: pg.ClientBase): Promise<DlqCounts> => {
  const result = await client.query<{ unresolved: string; total: string }>(
    `SELECT count(*) FILTER (WHERE resolved_at IS NULL AND NOT final_rejected) AS unresolved,
            count(*) AS total
     FROM core.dlq_message`,
  );
  const row = result.rows[0];

  return { unresolved: Number(row?.unresolved ?? 0), total: Number(row?.total ?? 0) };
};

/** Сколько первых байтов сообщения показывать. */
export const PAYLOAD_PREVIEW_BYTES = 160;

/** Непечатный символ: управляющие коды и замена неразобранной последовательности UTF-8. */
const isUnprintable = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xfffd;
};

/** Текст первых байтов сообщения: непечатное и оборванные символы заменены точкой. */
export const payloadPreview = (bytes: Buffer | null): string =>
  bytes === null
    ? ''
    : Array.from(bytes.subarray(0, PAYLOAD_PREVIEW_BYTES).toString('utf8'))
        .map((char) => (isUnprintable(char) ? '·' : char))
        .join('');

interface DlqMessageRow {
  readonly id: string;
  readonly source_topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly key: string | null;
  readonly error_class: string;
  readonly error: string;
  readonly attempts: number;
  readonly first_seen: Date;
  readonly last_seen: Date;
  readonly resolved_at: Date | null;
  readonly final_rejected: boolean;
  readonly preview: Buffer | null;
  readonly payload_bytes: number | null;
}

export interface DlqPage {
  readonly items: DlqMessage[];
  readonly nextCursor: string | null;
}

/**
 * Очередь недоставленных от новых к старым. Курсор это номер последней строки страницы:
 * новые сообщения страницу не сдвигают. Строка сверх запрошенных показывает, есть ли продолжение.
 */
export const listDlqMessages = async (
  client: pg.ClientBase,
  query: DlqListQuery,
): Promise<DlqPage> => {
  const result = await client.query<DlqMessageRow>(
    `SELECT id, source_topic, partition, "offset", key,
            coalesce(error->>'class', 'unknown') AS error_class,
            coalesce(error->>'message', '') AS error,
            attempts, first_seen, last_seen, resolved_at, final_rejected,
            substring(payload FROM 1 FOR $3) AS preview, octet_length(payload) AS payload_bytes
     FROM core.dlq_message
     WHERE $1::bigint IS NULL OR id < $1::bigint
     ORDER BY id DESC
     LIMIT $2`,
    [query.cursor ?? null, query.limit + 1, PAYLOAD_PREVIEW_BYTES],
  );

  const items = result.rows.slice(0, query.limit).map((row): DlqMessage => ({
    id: row.id,
    sourceTopic: row.source_topic,
    partition: row.partition,
    offset: row.offset,
    key: row.key,
    errorClass: row.error_class,
    error: row.error,
    attempts: row.attempts,
    firstSeen: row.first_seen.toISOString(),
    lastSeen: row.last_seen.toISOString(),
    resolvedAt: row.resolved_at === null ? null : row.resolved_at.toISOString(),
    finalRejected: row.final_rejected,
    payloadPreview: payloadPreview(row.preview),
    payloadBytes: row.payload_bytes ?? 0,
  }));
  const last = items[items.length - 1];

  return {
    items,
    nextCursor: result.rows.length > query.limit && last !== undefined ? last.id : null,
  };
};

interface RedriveRow {
  readonly id: string;
  readonly status: DlqRedriveStatus;
  readonly max_messages: number;
  readonly redriven: number;
  readonly rejected: number;
  readonly error: string | null;
  readonly requested_by: string;
  readonly created_at: Date;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
}

const REDRIVE_COLUMNS = `id, status, max_messages, redriven, rejected, error, requested_by,
  created_at, started_at, finished_at`;

const toRedrive = (row: RedriveRow): DlqRedrive => ({
  id: row.id,
  status: row.status,
  maxMessages: row.max_messages,
  redriven: row.redriven,
  rejected: row.rejected,
  error: row.error,
  requestedBy: row.requested_by,
  createdAt: row.created_at.toISOString(),
  startedAt: row.started_at === null ? null : row.started_at.toISOString(),
  finishedAt: row.finished_at === null ? null : row.finished_at.toISOString(),
});

export interface DlqRedriveEntry {
  readonly requestedBy: string;
  readonly maxMessages: number;
}

/** Запрос повторной подачи. Интерфейс только кладёт его, выполняет процессор. */
export const enqueueDlqRedrive = async (
  client: pg.ClientBase,
  entry: DlqRedriveEntry,
): Promise<DlqRedrive> => {
  const result = await client.query<RedriveRow>(
    `INSERT INTO core.dlq_redrive (requested_by, max_messages) VALUES ($1, $2)
     RETURNING ${REDRIVE_COLUMNS}`,
    [entry.requestedBy, entry.maxMessages],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('база не вернула запрос повторной подачи');

  return toRedrive(row);
};

export const loadDlqRedrive = async (
  client: pg.ClientBase,
  id: string,
): Promise<DlqRedrive | null> => {
  const result = await client.query<RedriveRow>(
    `SELECT ${REDRIVE_COLUMNS} FROM core.dlq_redrive WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];

  return row === undefined ? null : toRedrive(row);
};

/**
 * Забирает самый старый ждущий запрос и переводит его в работу. SKIP LOCKED отдаёт запрос,
 * который прямо сейчас забирает другой экземпляр, только ему одному. Вызывается в той же
 * транзакции, что и выполнение: смерть процесса посреди работы откатывает запрос в очередь,
 * а не оставляет его в работе навсегда.
 */
export const claimDlqRedrive = async (client: pg.ClientBase): Promise<DlqRedrive | null> => {
  const result = await client.query<RedriveRow>(
    `UPDATE core.dlq_redrive SET status = 'running', started_at = now()
     WHERE id = (
       SELECT id FROM core.dlq_redrive
       WHERE status = 'queued'
       ORDER BY id LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING ${REDRIVE_COLUMNS}`,
  );
  const row = result.rows[0];

  return row === undefined ? null : toRedrive(row);
};

/**
 * Запросы, оставшиеся в работе от прежнего выполнения отдельными транзакциями, завершаются
 * с ошибкой. Нынешнее выполнение не фиксирует состояние «в работе», поэтому такая строка
 * уже никем не выполняется. Возвращает число завершённых.
 */
export const failStaleDlqRedrives = async (
  client: pg.ClientBase,
  error: string,
  finishedAt: string,
): Promise<number> => {
  const result = await client.query(
    `UPDATE core.dlq_redrive SET status = 'failed', error = $1, finished_at = $2
     WHERE status = 'running'`,
    [error, finishedAt],
  );

  return result.rowCount ?? 0;
};

export interface DlqRedriveOutcome {
  readonly status: 'done' | 'failed';
  readonly redriven: number;
  readonly rejected: number;
  readonly error: string | null;
}

/**
 * Завершение запроса со счётами. Завершённый не переписывается: сбой, записанный после отката,
 * не затрёт итог экземпляра, который успел забрать запрос заново и выполнить его.
 */
export const finishDlqRedrive = async (
  client: pg.ClientBase,
  id: string,
  outcome: DlqRedriveOutcome,
  finishedAt: string,
): Promise<void> => {
  await client.query(
    `UPDATE core.dlq_redrive
     SET status = $2, redriven = $3, rejected = $4, error = $5, finished_at = $6
     WHERE id = $1 AND status IN ('queued', 'running')`,
    [
      id,
      outcome.status,
      outcome.redriven,
      outcome.rejected,
      outcome.error?.slice(0, 1_000) ?? null,
      finishedAt,
    ],
  );
};

/** Сообщение, отобранное под повторную подачу, со всем, что нужно для отправки. */
export interface DlqRedriveCandidate {
  readonly id: string;
  readonly sourceTopic: string;
  readonly key: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: Buffer | null;
  readonly attempts: number;
  readonly firstSeen: string;
}

export interface DlqRedriveSelection {
  readonly topics: readonly string[];
  readonly limit: number;
}

/**
 * Ждущие разбора сообщения под повторную подачу, старые первыми. Строки блокируются до конца
 * транзакции: второй экземпляр их пропустит, и одно сообщение не уйдёт в топик дважды.
 * Работает только внутри транзакции.
 */
export const selectDlqForRedrive = async (
  client: pg.ClientBase,
  selection: DlqRedriveSelection,
): Promise<DlqRedriveCandidate[]> => {
  const result = await client.query<{
    id: string;
    source_topic: string;
    key: string | null;
    headers: Record<string, string> | null;
    payload: Buffer | null;
    attempts: number;
    first_seen: Date;
  }>(
    `SELECT id, source_topic, key, headers, payload, attempts, first_seen
     FROM core.dlq_message
     WHERE resolved_at IS NULL AND NOT final_rejected AND source_topic = ANY($1::text[])
     ORDER BY id LIMIT $2
     FOR UPDATE SKIP LOCKED`,
    [[...selection.topics], selection.limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    sourceTopic: row.source_topic,
    key: row.key,
    headers: row.headers ?? {},
    payload: row.payload,
    attempts: row.attempts,
    firstSeen: row.first_seen.toISOString(),
  }));
};

/**
 * Сообщения вернулись в исходный топик или их копия уже дошла до процессора. Прежняя отметка
 * не перетирается, окончательно отвергнутые не трогаются.
 */
export const markDlqResolved = async (
  client: pg.ClientBase,
  ids: readonly string[],
  resolvedAt: string,
): Promise<void> => {
  if (ids.length === 0) return;

  await client.query(
    `UPDATE core.dlq_message SET resolved_at = $2
     WHERE id = ANY($1::bigint[]) AND resolved_at IS NULL AND NOT final_rejected`,
    [ids, resolvedAt],
  );
};

/** Копия строки очереди, дошедшая до процессора: номер строки из заголовка, топик и ключ копии. */
export interface DlqCopy {
  readonly id: string;
  readonly sourceTopic: string;
  readonly key: string | null;
}

/**
 * Копии закрывают свои строки очереди. Строка закрывается, только если топик и ключ совпадают
 * с копией: чужой номер в заголовке ничего не закроет. Строку, которую сейчас держит транзакция
 * подачи, запрос пропускает и не ждёт конца отправки: её закроет сама подача, а после отката
 * следующая копия.
 */
export const resolveDlqCopies = async (
  client: pg.ClientBase,
  copies: readonly DlqCopy[],
  resolvedAt: string,
): Promise<void> => {
  if (copies.length === 0) return;

  await client.query(
    `UPDATE core.dlq_message SET resolved_at = $4
     WHERE id IN (
       SELECT m.id
       FROM core.dlq_message m
       JOIN unnest($1::bigint[], $2::text[], $3::text[]) AS c(id, source_topic, key)
         ON m.id = c.id AND m.source_topic = c.source_topic AND m.key IS NOT DISTINCT FROM c.key
       WHERE m.resolved_at IS NULL AND NOT m.final_rejected
       FOR UPDATE OF m SKIP LOCKED
     )`,
    [
      copies.map((copy) => copy.id),
      copies.map((copy) => copy.sourceTopic),
      copies.map((copy) => copy.key),
      resolvedAt,
    ],
  );
};

/** Сообщения исчерпали попытки: больше в топик не подаются и разбора не ждут. */
export const markDlqFinalRejected = async (
  client: pg.ClientBase,
  ids: readonly string[],
): Promise<void> => {
  if (ids.length === 0) return;

  await client.query(
    `UPDATE core.dlq_message SET final_rejected = true WHERE id = ANY($1::bigint[])`,
    [ids],
  );
};
