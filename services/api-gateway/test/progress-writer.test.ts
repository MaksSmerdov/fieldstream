import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgressWriter } from '../src/scenarios/progress-writer.js';

const clock = { now: () => Date.now() };

/** Запись с учётом того, что и когда записано. */
const recorder = () => {
  const written: { value: number; atMs: number }[] = [];
  return {
    written,
    write: (value: number) => {
      written.push({ value, atMs: Date.now() });
      return Promise.resolve();
    },
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_770_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('запись хода прогона', () => {
  it('первый снимок пишется сразу, снимки внутри секунды схлопываются в последний', async () => {
    const { written, write } = recorder();
    const writer = createProgressWriter({ intervalMs: 1_000, clock, write, onError: () => {} });
    const start = Date.now();

    writer.push(1);
    writer.push(2);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300);
    writer.push(3);
    await vi.advanceTimersByTimeAsync(700);
    writer.push(4);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(written).toEqual([
      { value: 1, atMs: start },
      { value: 3, atMs: start + 1_000 },
      { value: 4, atMs: start + 2_000 },
    ]);
  });

  it('close дожидается начатой записи и отбрасывает отложенный снимок', async () => {
    let release = (): void => {};
    const written: number[] = [];
    const writer = createProgressWriter({
      intervalMs: 1_000,
      clock,
      write: (value: number) =>
        new Promise<void>((resolve) => {
          release = () => {
            written.push(value);
            resolve();
          };
        }),
      onError: () => {},
    });

    writer.push(1);
    writer.push(2);
    let closed = false;
    const closing = writer.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(closed).toBe(false);

    release();
    await closing;
    writer.push(3);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(written).toEqual([1]);
  });

  it('сбой записи уходит в onError и следующие записи не останавливает', async () => {
    const errors: unknown[] = [];
    const written: number[] = [];
    const writer = createProgressWriter({
      intervalMs: 1_000,
      clock,
      write: (value: number) => {
        if (value === 1) return Promise.reject(new Error('база недоступна'));
        written.push(value);
        return Promise.resolve();
      },
      onError: (error) => {
        errors.push(error);
      },
    });

    writer.push(1);
    await vi.advanceTimersByTimeAsync(1_000);
    writer.push(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await writer.close();

    expect(errors).toHaveLength(1);
    expect(written).toEqual([2]);
  });
});
