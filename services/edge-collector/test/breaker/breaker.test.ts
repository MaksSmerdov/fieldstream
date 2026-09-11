import { describe, expect, it } from 'vitest';
import {
  BREAKER,
  CLOSED_BREAKER,
  breakerAllows,
  breakerView,
  recordFailure,
  recordSuccess,
} from '../../src/breaker/breaker.js';

describe('размыкатель', () => {
  it('один отказ только считается, источник по-прежнему опрашивается', () => {
    const breaker = recordFailure(CLOSED_BREAKER, 0);

    expect(breaker.failures).toBe(1);
    expect(breakerAllows(breaker, 0)).toBe(true);
    expect(breakerView(breaker, 0)).toBe('closed');
  });

  it('два отказа подряд уводят источник на пробу через 30 секунд', () => {
    const breaker = recordFailure(recordFailure(CLOSED_BREAKER, 0), 1_000);

    expect(breaker.open).toBe(true);
    expect(breaker.nextProbeAt).toBe(1_000 + BREAKER.firstProbeMs);
    expect(breakerAllows(breaker, 30_999)).toBe(false);
    expect(breakerView(breaker, 30_999)).toBe('open');
    expect(breakerAllows(breaker, 31_000)).toBe(true);
    expect(breakerView(breaker, 31_000)).toBe('half_open');
  });

  it('каждая неудачная проба удваивает паузу, но не выше пяти минут', () => {
    let breaker = recordFailure(recordFailure(CLOSED_BREAKER, 0), 0);
    const delays = [breaker.probeDelayMs];

    for (let probe = 0; probe < 6; probe += 1) {
      breaker = recordFailure(breaker, 0);
      delays.push(breaker.probeDelayMs);
    }

    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
  });

  it('успех закрывает размыкатель и обнуляет счёт', () => {
    const open = recordFailure(recordFailure(CLOSED_BREAKER, 0), 0);

    expect(recordSuccess()).toEqual(CLOSED_BREAKER);
    expect(breakerAllows(recordSuccess(), 0)).toBe(true);
    expect(open.open).toBe(true);
  });
});
