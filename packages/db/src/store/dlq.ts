import type pg from 'pg';

export interface DlqCounts {
  readonly unresolved: number;
  readonly total: number;
}

/** Счёт очереди недоставленных: сколько ждёт разбора и сколько всего. */
export const loadDlqCounts = async (client: pg.ClientBase): Promise<DlqCounts> => {
  const result = await client.query<{ unresolved: string; total: string }>(
    `SELECT count(*) FILTER (WHERE resolved_at IS NULL) AS unresolved, count(*) AS total
     FROM core.dlq_message`,
  );
  const row = result.rows[0];

  return { unresolved: Number(row?.unresolved ?? 0), total: Number(row?.total ?? 0) };
};
