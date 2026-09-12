import type pg from 'pg';

/** Сессия обновления: одна строка на вкладку, токен хранится только хешем. */
export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}

export interface NewSession {
  readonly userId: string;
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly userAgent: string | null;
  readonly ip: string | null;
}

interface SessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly session_id: string;
  readonly expires_at: Date;
}

const toRecord = (row: SessionRow): SessionRecord => ({
  id: row.id,
  userId: row.user_id,
  sessionId: row.session_id,
  expiresAt: row.expires_at.toISOString(),
});

export const createSession = async (
  client: pg.ClientBase,
  session: NewSession,
): Promise<SessionRecord> => {
  const result = await client.query<SessionRow>(
    `INSERT INTO core.refresh_sessions
       (user_id, session_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, session_id, expires_at`,
    [
      session.userId,
      session.sessionId,
      session.tokenHash,
      session.expiresAt,
      session.userAgent,
      session.ip,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('сессия не создалась');
  return toRecord(row);
};

/**
 * Ротация токена обновления. Атомарный UPDATE: при двух одновременных запросах строку
 * получает ровно один, второй видит ноль строк и разбирается по своему окну повтора,
 * а не разлогинивает пользователя.
 */
export const rotateSession = async (
  client: pg.ClientBase,
  previousHash: string,
  nextHash: string,
  expiresAt: string,
): Promise<SessionRecord | null> => {
  const result = await client.query<SessionRow>(
    `UPDATE core.refresh_sessions
     SET token_hash = $2, prev_token_hash = $1, rotated_at = now(), expires_at = $3
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
     RETURNING id, user_id, session_id, expires_at`,
    [previousHash, nextHash, expiresAt],
  );
  return result.rows[0] === undefined ? null : toRecord(result.rows[0]);
};

/** Сессия, из которой этот токен уже прокручен: предъявленный старый токен это тревожный признак. */
export const findRotatedFrom = async (
  client: pg.ClientBase,
  tokenHash: string,
): Promise<SessionRecord | null> => {
  const result = await client.query<SessionRow>(
    `SELECT id, user_id, session_id, expires_at FROM core.refresh_sessions
     WHERE prev_token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash],
  );
  return result.rows[0] === undefined ? null : toRecord(result.rows[0]);
};

/** Отзыв по токену: обычный выход. */
export const revokeSessionByToken = async (
  client: pg.ClientBase,
  tokenHash: string,
): Promise<boolean> => {
  const result = await client.query(
    `UPDATE core.refresh_sessions SET revoked_at = now()
     WHERE (token_hash = $1 OR prev_token_hash = $1) AND revoked_at IS NULL`,
    [tokenHash],
  );
  return (result.rowCount ?? 0) > 0;
};

/** Отзыв по идентификатору: так закрывается сессия, токен которой предъявили повторно. */
export const revokeSessionById = async (client: pg.ClientBase, id: string): Promise<void> => {
  await client.query('UPDATE core.refresh_sessions SET revoked_at = now() WHERE id = $1', [id]);
};
