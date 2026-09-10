import { describe, expect, it } from 'vitest';
import { createFakeClock, SystemClock, toIsoTimestamp } from './clock.js';

describe('clock', () => {
  it('FakeClock стартует с заданного момента', () => {
    expect(createFakeClock(1_700_000_000_000).now()).toBe(1_700_000_000_000);
    expect(createFakeClock().now()).toBe(0);
  });

  it('FakeClock двигает время методами set и advance', () => {
    const clock = createFakeClock(1_000);

    clock.advance(500);
    expect(clock.now()).toBe(1_500);

    clock.set(42);
    expect(clock.now()).toBe(42);

    clock.advance(-42);
    expect(clock.now()).toBe(0);
  });

  it('SystemClock отдаёт растущее системное время', () => {
    const before = Date.now();
    const value = SystemClock.now();

    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(Date.now());
  });

  it('toIsoTimestamp даёт ISO-время с зоной, как требуют контракты', () => {
    expect(toIsoTimestamp(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02T03:04:05.000Z');
  });
});
