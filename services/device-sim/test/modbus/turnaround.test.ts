import { describe, expect, it } from 'vitest';
import { createTurnaround } from '../../src/modbus/turnaround.js';
import type { TurnaroundOptions } from '../../src/modbus/turnaround.js';

const OPTIONS: TurnaroundOptions = {
  seed: 'turnaround-test',
  lineCode: 'L1',
  baseMs: 5,
  jitterMs: 40,
};

const sample = (options: TurnaroundOptions, count: number): number[] => {
  const turnaround = createTurnaround(options);
  return Array.from({ length: count }, () => turnaround());
};

describe('задержка ответа прибора', () => {
  it('при одном сиде и одной линии последовательность задержек повторяется', () => {
    expect(sample(OPTIONS, 200)).toEqual(sample(OPTIONS, 200));
  });

  it('у другой линии и другого сида своя последовательность', () => {
    const base = sample(OPTIONS, 50);

    expect(sample({ ...OPTIONS, lineCode: 'L2' }, 50)).not.toEqual(base);
    expect(sample({ ...OPTIONS, seed: 'other' }, 50)).not.toEqual(base);
  });

  it('задержки различаются, целые и лежат между базой и базой плюс разброс', () => {
    const delays = sample(OPTIONS, 1000);

    expect(new Set(delays).size).toBeGreaterThan(20);
    expect(delays.every((delay) => Number.isInteger(delay))).toBe(true);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(5);
    expect(Math.max(...delays)).toBeLessThanOrEqual(45);
  });

  it('медиана добавки мала, а хвост дотягивается почти до предела', () => {
    const delays = sample({ ...OPTIONS, baseMs: 0, jitterMs: 1000 }, 1001).sort(
      (left, right) => left - right,
    );

    expect(delays[500]).toBeLessThan(250);
    expect(delays[990]).toBeGreaterThan(700);
  });

  it('без разброса задержка всегда равна базе', () => {
    expect(new Set(sample({ ...OPTIONS, jitterMs: 0 }, 100))).toEqual(new Set([5]));
  });
});
