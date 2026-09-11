import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HardTimeoutError, cycleWatchdogMs, hardTimeoutMs, withHardTimeout } from './timeouts.js';

describe('таймауты', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('значения по умолчанию: 600 мс дают жёсткие 1450, опрос раз в 10 с даёт сторож в 5 минут', () => {
    expect(hardTimeoutMs(600)).toBe(1_450);
    expect(cycleWatchdogMs(10_000)).toBe(300_000);
    expect(cycleWatchdogMs(60_000)).toBe(360_000);
  });

  it('промис, который не завершается никогда, снимается жёстким таймаутом', async () => {
    const hung = withHardTimeout(new Promise<never>(() => undefined), 1_450);
    const settled = expect(hung).rejects.toBeInstanceOf(HardTimeoutError);

    await vi.advanceTimersByTimeAsync(1_449);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
  });

  it('успевшая работа возвращает свой результат, а таймер снимается', async () => {
    const result = withHardTimeout(Promise.resolve(42), 1_450);

    await expect(result).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ошибка работы проходит как есть, а не превращается в таймаут', async () => {
    await expect(withHardTimeout(Promise.reject(new Error('обрыв')), 1_450)).rejects.toThrow(
      'обрыв',
    );
  });
});
