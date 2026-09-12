import { describe, expect, it } from 'vitest';
import { takeToken } from '../../src/store/rate-limit.js';

const SETTINGS = { capacity: 5, refillMs: 30_000 };
const T0 = 1_760_000_000_000;

describe('ведро попыток', () => {
  it('первая попытка с пустой строкой разрешена и ничего не стоит при нулевой цене', () => {
    expect(takeToken(null, T0, SETTINGS, 0)).toEqual({
      allowed: true,
      tokens: 5,
      retryAfterMs: 0,
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
});
