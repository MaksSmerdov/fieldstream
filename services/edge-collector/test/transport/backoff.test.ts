import { describe, expect, it } from 'vitest';
import { RECONNECT, reconnectDelay } from '../../src/transport/backoff.js';

describe('задержка переподключения', () => {
  it('база растёт вдвое с каждой попыткой и упирается в 30 секунд', () => {
    const bases = [0, 1, 2, 3, 4, 5, 6, 10].map(
      (attempt) => reconnectDelay(attempt, () => 0.5).baseMs,
    );

    expect(bases).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  it('на 10 000 выборках джиттер укладывается в ±10% и не вырожден', () => {
    const jitters = new Set<number>();

    for (let sample = 0; sample < 10_000; sample += 1) {
      const step = reconnectDelay(3, Math.random);
      expect(Math.abs(step.jitterMs)).toBeLessThanOrEqual(RECONNECT.jitter * step.baseMs);
      expect(step.chosenMs).toBe(step.baseMs + step.jitterMs);
      jitters.add(step.jitterMs);
    }

    expect(jitters.size).toBeGreaterThan(500);
    expect(Math.min(...jitters)).toBeLessThan(-700);
    expect(Math.max(...jitters)).toBeGreaterThan(700);
  });

  it('крайние значения генератора дают ровно границы джиттера', () => {
    expect(reconnectDelay(0, () => 0)).toEqual({ baseMs: 1_000, jitterMs: -100, chosenMs: 900 });
    expect(reconnectDelay(0, () => 1)).toEqual({ baseMs: 1_000, jitterMs: 100, chosenMs: 1_100 });
  });
});
