/**
 * Правило выбора источника серии. Одна и та же чистая функция живёт на сервере и на фронте,
 * поэтому подпись под графиком не может разойтись с тем, откуда данные взяты на самом деле.
 * Это прямое лечение двух болячек сразу: эндпоинта без limit и фронта,
 * перезапрашивающего всё окно чаще, чем данные вообще меняются.
 */
export type SeriesSource = 'readings' | 'readings_1m' | 'readings_1h';

export interface SeriesPlan {
  source: SeriesSource;
  /** Шаг агрегации в миллисекундах. */
  bucketMs: number;
  points: number;
  /** Окно прорежено: точек в ответе меньше, чем отсчётов в источнике. */
  truncated: boolean;
}

export const MAX_SERIES_POINTS = 2000;

const HOUR_MS = 3_600_000;
const SIX_HOURS_MS = 6 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * 24 * HOUR_MS;
const MINUTE_MS = 60_000;

/** Шаги, кратные разрешению источника: иначе бакеты не сойдутся с материализованными. */
const roundBucket = (rawMs: number, minMs: number): number =>
  Math.max(minMs, Math.ceil(rawMs / minMs) * minMs);

export const pickSource = (rangeMs: number, maxPoints = MAX_SERIES_POINTS): SeriesPlan => {
  if (rangeMs <= 0 || maxPoints <= 0) {
    return { source: 'readings', bucketMs: 10_000, points: 0, truncated: false };
  }

  const source: SeriesSource =
    rangeMs <= SIX_HOURS_MS ? 'readings' : rangeMs <= SEVEN_DAYS_MS ? 'readings_1m' : 'readings_1h';

  const minBucketMs =
    source === 'readings' ? 10_000 : source === 'readings_1m' ? MINUTE_MS : HOUR_MS;
  const bucketMs = roundBucket(rangeMs / maxPoints, minBucketMs);
  const points = Math.ceil(rangeMs / bucketMs);
  // Прорежено: в источнике отсчётов больше, чем точек в ответе. Шаг всегда кратен разрешению
  // источника, поэтому число точек само по себе предела не превышает, и сравнивать надо с ним.
  const available = Math.ceil(rangeMs / minBucketMs);

  return { source, bucketMs, points, truncated: available > points };
};
