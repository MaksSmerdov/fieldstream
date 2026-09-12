import type { SeriesMetric } from '@fieldstream/contracts';

/** Данные графика: общая шкала времени в секундах и по колонке значений на метрику. */
export interface AlignedSeries {
  readonly xs: number[];
  readonly ys: (number | null)[][];
}

/**
 * Общая шкала для нескольких метрик: у одной может не быть точки в бакете, где у соседней она
 * есть. Пропуск остаётся пропуском, иначе график соединит прямой часы без данных.
 */
export const alignSeries = (metrics: readonly SeriesMetric[]): AlignedSeries => {
  const stamps = new Set<number>();

  for (const metric of metrics) {
    for (const point of metric.points) {
      const atMs = Date.parse(point.t);
      if (!Number.isNaN(atMs)) stamps.add(atMs);
    }
  }

  const sorted = [...stamps].sort((left, right) => left - right);
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
