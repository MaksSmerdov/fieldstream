import { describe, expect, it } from 'vitest';
import type { SeriesPlan, SeriesSource } from '../src/series.js';
import { MAX_SERIES_POINTS, pickSource } from '../src/series.js';

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SIX_HOURS_MS = 6 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;

/** Разрешение источника: бакет обязан быть кратен ему, иначе не сойдётся с материализованными агрегатами. */
const RESOLUTION_MS: Readonly<Record<SeriesSource, number>> = {
  readings: 10 * SECOND_MS,
  readings_1m: MINUTE_MS,
  readings_1h: HOUR_MS,
};

const RANGES_MS: readonly number[] = [
  1,
  SECOND_MS,
  30 * SECOND_MS,
  5 * MINUTE_MS,
  HOUR_MS,
  SIX_HOURS_MS - 1,
  SIX_HOURS_MS,
  SIX_HOURS_MS + 1,
  DAY_MS,
  3 * DAY_MS,
  SEVEN_DAYS_MS - 1,
  SEVEN_DAYS_MS,
  SEVEN_DAYS_MS + 1,
  30 * DAY_MS,
  365 * DAY_MS,
  5 * 365 * DAY_MS,
];

const LIMITS: readonly number[] = [1, 2, 7, 60, 500, 1999, MAX_SERIES_POINTS, 5_000, 100_000];

interface SeriesCase {
  rangeMs: number;
  maxPoints: number;
}

const CASES: readonly SeriesCase[] = RANGES_MS.flatMap((rangeMs) =>
  LIMITS.map((maxPoints) => ({ rangeMs, maxPoints })),
);

/** Случаи, нарушившие инвариант, в читаемом виде: упавший тест называет окно и лимит. */
const violations = (isBroken: (plan: SeriesPlan, seriesCase: SeriesCase) => boolean): string[] =>
  CASES.filter((seriesCase) =>
    isBroken(pickSource(seriesCase.rangeMs, seriesCase.maxPoints), seriesCase),
  ).map((seriesCase) => {
    const plan = pickSource(seriesCase.rangeMs, seriesCase.maxPoints);
    return `окно ${seriesCase.rangeMs} мс, лимит ${seriesCase.maxPoints}: ${plan.source}, бакет ${plan.bucketMs}, точек ${plan.points}, truncated ${String(plan.truncated)}`;
  });

describe('pickSource', () => {
  it('ровно шесть часов ещё читаются из сырых показаний', () => {
    expect(pickSource(SIX_HOURS_MS)).toEqual({
      source: 'readings',
      bucketMs: 20_000,
      points: 1080,
      truncated: false,
    });
  });

  it('чуть больше шести часов уходит на минутные агрегаты', () => {
    expect(pickSource(SIX_HOURS_MS + 1)).toEqual({
      source: 'readings_1m',
      bucketMs: MINUTE_MS,
      points: 361,
      truncated: false,
    });
  });

  it('ровно семь суток ещё читаются из минутных агрегатов', () => {
    expect(pickSource(SEVEN_DAYS_MS)).toEqual({
      source: 'readings_1m',
      bucketMs: 6 * MINUTE_MS,
      points: 1680,
      truncated: false,
    });
  });

  it('больше семи суток уходит на часовые агрегаты', () => {
    expect(pickSource(SEVEN_DAYS_MS + 1)).toEqual({
      source: 'readings_1h',
      bucketMs: HOUR_MS,
      points: 169,
      truncated: false,
    });
  });

  it('окно, уложившееся ровно в maxPoints, не считается обрезанным', () => {
    const plan = pickSource(MAX_SERIES_POINTS * 10 * SECOND_MS);

    expect(plan.source).toBe('readings');
    expect(plan.bucketMs).toBe(10 * SECOND_MS);
    expect(plan.points).toBe(MAX_SERIES_POINTS);
    expect(plan.truncated).toBe(false);
  });

  it('произвольный лимит на своей границе тоже не считается обрезанным', () => {
    const plan = pickSource(500 * MINUTE_MS, 500);

    expect(plan.points).toBe(500);
    expect(plan.truncated).toBe(false);
  });

  it('бакет всегда кратен разрешению источника', () => {
    expect(violations((plan) => plan.bucketMs % RESOLUTION_MS[plan.source] !== 0)).toEqual([]);
  });

  it('узкое окно не даёт бакет мельче разрешения источника', () => {
    expect(violations((plan) => plan.bucketMs < RESOLUTION_MS[plan.source])).toEqual([]);
    expect(pickSource(5 * SECOND_MS).bucketMs).toBe(10 * SECOND_MS);
    expect(pickSource(SIX_HOURS_MS + 1, 100_000).bucketMs).toBe(MINUTE_MS);
    expect(pickSource(SEVEN_DAYS_MS + 1, 100_000).bucketMs).toBe(HOUR_MS);
  });

  it('число точек никогда не превышает лимит', () => {
    expect(violations((plan, seriesCase) => plan.points > seriesCase.maxPoints)).toEqual([]);
  });

  it('truncated поднимается ровно тогда, когда точек больше лимита', () => {
    expect(
      violations((plan, seriesCase) => plan.truncated !== plan.points > seriesCase.maxPoints),
    ).toEqual([]);
  });

  it('обрезка отмечается, когда план в лимит не уложился', () => {
    const plan = pickSource(25 * SECOND_MS, 2.5);

    expect(plan.points).toBe(3);
    expect(plan.truncated).toBe(true);
  });

  it('источник переключается только на своих границах', () => {
    expect(
      violations((plan, seriesCase) => {
        const expected: SeriesSource =
          seriesCase.rangeMs <= SIX_HOURS_MS
            ? 'readings'
            : seriesCase.rangeMs <= SEVEN_DAYS_MS
              ? 'readings_1m'
              : 'readings_1h';
        return plan.source !== expected;
      }),
    ).toEqual([]);
  });

  it('вырожденные входы дают пустой план на сырых показаниях', () => {
    const empty: SeriesPlan = {
      source: 'readings',
      bucketMs: 10 * SECOND_MS,
      points: 0,
      truncated: false,
    };

    expect(pickSource(0)).toEqual(empty);
    expect(pickSource(-1)).toEqual(empty);
    expect(pickSource(-SEVEN_DAYS_MS)).toEqual(empty);
    expect(pickSource(HOUR_MS, 0)).toEqual(empty);
    expect(pickSource(HOUR_MS, -10)).toEqual(empty);
    expect(pickSource(0, 0)).toEqual(empty);
  });
});
