import type pg from 'pg';

/** Состояние ведра запросов: сколько токенов осталось и когда пополняли. */
export interface BucketState {
  readonly tokens: number;
  readonly refilledAtMs: number;
}

export interface BucketSettings {
  readonly capacity: number;
  readonly refillMs: number;
}

export interface BucketDecision {
  readonly allowed: boolean;
  readonly tokens: number;
  readonly retryAfterMs: number;
}

/**
 * Пополнение и списание: чистая арифметика, поэтому поведение ограничителя проверяется
 * без базы. Ведро копит по одному токену за refillMs и не выше ёмкости. Цена нулевая это
 * вопрос «можно ли», цена единица это отметка неудачной попытки.
 */
export const takeToken = (
  state: BucketState | null,
  nowMs: number,
  settings: BucketSettings,
  cost = 1,
): BucketDecision => {
  const previous = state ?? { tokens: settings.capacity, refilledAtMs: nowMs };
  const gained = Math.floor(Math.max(0, nowMs - previous.refilledAtMs) / settings.refillMs);
  const available = Math.min(settings.capacity, previous.tokens + gained);

  if (available <= 0) {
    const waited = Math.max(0, nowMs - previous.refilledAtMs) % settings.refillMs;
    return { allowed: false, tokens: 0, retryAfterMs: settings.refillMs - waited };
  }

  return { allowed: true, tokens: Math.max(0, available - cost), retryAfterMs: 0 };
};

/**
 * Ограничитель на таблице, а не в памяти процесса: перезапуск шлюза не обнуляет счётчик
 * попыток входа, и при нескольких экземплярах ведро остаётся общим. Платят только неудачные
 * попытки, поэтому обычная работа в лимит не упирается, а подбор упирается.
 */
export const consumeRateLimit = async (
  client: pg.PoolClient,
  bucketKey: string,
  nowMs: number,
  settings: BucketSettings,
  cost = 1,
): Promise<BucketDecision> => {
  await client.query('BEGIN');

  try {
    const current = await client.query<{ tokens: number; refilled_at: Date }>(
      'SELECT tokens, refilled_at FROM core.rate_limit WHERE bucket_key = $1 FOR UPDATE',
      [bucketKey],
    );
    const row = current.rows[0];
    const decision = takeToken(
      row === undefined ? null : { tokens: row.tokens, refilledAtMs: row.refilled_at.getTime() },
      nowMs,
      settings,
      cost,
    );

    await client.query(
      `INSERT INTO core.rate_limit (bucket_key, tokens, refilled_at) VALUES ($1, $2, $3)
       ON CONFLICT (bucket_key) DO UPDATE SET tokens = $2, refilled_at = $3`,
      [bucketKey, decision.tokens, new Date(nowMs).toISOString()],
    );
    await client.query('COMMIT');

    return decision;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
};
