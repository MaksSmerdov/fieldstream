import type { SeriesMetric } from '@fieldstream/contracts';

/** Данные графика: общая шкала времени в секундах и по колонке значений на метрику. */
export interface AlignedSeries {
  readonly xs: number[];
  readonly ys: (number | null)[][];
}

/** Сколько шагов бакета без точек подряд считается разрывом, а не случайно пустым бакетом. */
const GAP_BUCKETS = 3;

/**
 * Общая шкала для нескольких метрик: у одной может не быть точки в бакете, где у соседней она
 * есть. Пропуск остаётся пропуском: разрыв длиннее GAP_BUCKETS шагов получает пустую точку,
 * иначе график соединит прямой часы без данных.
 */
export const alignSeries = (metrics: readonly SeriesMetric[], bucketMs?: number): AlignedSeries => {
  const stamps = new Set<number>();

  for (const metric of metrics) {
    for (const point of metric.points) {
      const atMs = Date.parse(point.t);
      if (!Number.isNaN(atMs)) stamps.add(atMs);
    }
  }

  const sorted: number[] = [];
  for (const atMs of [...stamps].sort((left, right) => left - right)) {
    const previous = sorted.at(-1);
    if (
      bucketMs !== undefined &&
      previous !== undefined &&
      atMs - previous > GAP_BUCKETS * bucketMs
    ) {
      sorted.push(previous + bucketMs);
    }
    sorted.push(atMs);
  }
  const index = new Map(sorted.map((atMs, position) => [atMs, position]));

  const ys = metrics.map((metric) => {
    const column: (number | null)[] = Array.from({ length: sorted.length }, () => null);
    for (const point of metric.points) {
      const position = index.get(Date.parse(point.t));
      if (position !== undefined) column[position] = point.avg;
    }

    return column;
  });

  return { xs: sorted.map((atMs) => atMs / 1000), ys };
};
