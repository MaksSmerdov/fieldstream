import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { consumeRateLimit, takeToken } from '../../src/store/rate-limit.js';

const SETTINGS = { capacity: 5, refillMs: 30_000 };
const T0 = 1_760_000_000_000;

interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** База с одной строкой ведра: запоминает всё, что ей прислали. */
const fakeClient = (
  row: { tokens: number; refilled_at: Date } | undefined,
): { client: pg.PoolClient; statements: Statement[] } => {
  const statements: Statement[] = [];
  const client = {
    query: (sql: string, params: readonly unknown[] = []) => {
      statements.push({ sql, params });
      if (sql.includes('SELECT tokens')) {
        return Promise.resolve({ rows: row === undefined ? [] : [row], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };

  return { client: client as unknown as pg.PoolClient, statements };
};

const writtenRefilledAt = (statements: readonly Statement[]): unknown =>
  statements.find(({ sql }) => sql.includes('INSERT INTO core.rate_limit'))?.params[2];

describe('ведро попыток', () => {
  it('первая попытка с пустой строкой разрешена и ничего не стоит при нулевой цене', () => {
    expect(takeToken(null, T0, SETTINGS, 0)).toEqual({
      allowed: true,
      tokens: 5,
      retryAfterMs: 0,
      refilledAtMs: T0,
    });
  });

  it('неудачная попытка забирает токен', () => {
    expect(takeToken({ tokens: 5, refilledAtMs: T0 }, T0, SETTINGS, 1).tokens).toBe(4);
  });

  it('исчерпанное ведро отказывает и говорит, сколько ждать', () => {
    const decision = takeToken({ tokens: 0, refilledAtMs: T0 }, T0 + 10_000, SETTINGS, 0);

    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBe(20_000);
  });

  it('время возвращает попытки по одной и не выше ёмкости', () => {
    expect(takeToken({ tokens: 0, refilledAtMs: T0 }, T0 + 30_000, SETTINGS, 0).allowed).toBe(true);
    expect(takeToken({ tokens: 0, refilledAtMs: T0 }, T0 + 10 * 30_000, SETTINGS, 0).tokens).toBe(
      5,
    );
  });

  it('проверка ценой ноль не отодвигает точку отсчёта пополнения', () => {
    const empty = { tokens: 0, refilledAtMs: T0 };

    expect(takeToken(empty, T0 + 10_000, SETTINGS, 0).refilledAtMs).toBe(T0);
    expect(takeToken(empty, T0 + 29_000, SETTINGS, 0).refilledAtMs).toBe(T0);
    expect(takeToken(empty, T0 + 30_000, SETTINGS, 0).allowed).toBe(true);
  });

  it('точка отсчёта сдвигается на выданные токены, остаток ожидания не пропадает', () => {
    const decision = takeToken({ tokens: 0, refilledAtMs: T0 }, T0 + 45_000, SETTINGS, 1);

    expect(decision).toEqual({
      allowed: true,
      tokens: 0,
      retryAfterMs: 0,
      refilledAtMs: T0 + 30_000,
    });
  });
});

describe('ведро попыток в таблице', () => {
  it('поток дешёвых проверок держит ведро в нуле не дольше окна пополнения', async () => {
    const row = { tokens: 0, refilled_at: new Date(T0) };

    for (const at of [T0 + 5_000, T0 + 10_000, T0 + 15_000]) {
      const { client, statements } = fakeClient(row);
      const decision = await consumeRateLimit(client, 'login:email:жертва', at, SETTINGS, 0);

      expect(decision.allowed).toBe(false);
      expect(writtenRefilledAt(statements)).toBe(new Date(T0).toISOString());
    }

    const { client } = fakeClient(row);
    await expect(
      consumeRateLimit(client, 'login:email:жертва', T0 + 30_000, SETTINGS, 0),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('удачная попытка пишет остаток токенов и точку отсчёта по выданным токенам', async () => {
    const { client, statements } = fakeClient({ tokens: 3, refilled_at: new Date(T0) });

    const decision = await consumeRateLimit(
      client,
      'login:ip:203.0.113.9',
      T0 + 45_000,
      SETTINGS,
      1,
    );

    expect(decision.tokens).toBe(3);
    expect(writtenRefilledAt(statements)).toBe(new Date(T0 + 30_000).toISOString());
    expect(statements.map(({ sql }) => sql).at(-1)).toBe('COMMIT');
  });
});
