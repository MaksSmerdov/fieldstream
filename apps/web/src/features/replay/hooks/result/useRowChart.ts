import { useQuery } from '@tanstack/react-query';
import type {
  ReplayDiffRow,
  ReplayEpisodesResponse,
  ReplayRun,
  SeriesResponse,
} from '@fieldstream/contracts';
import { api } from '../../../../shared/api/endpoints.js';
import { queryKeys } from '../../../../shared/api/query-keys.js';

const MAX_POINTS = 800;

export interface RowChartData {
  readonly episodes: ReplayEpisodesResponse | undefined;
  readonly series: SeriesResponse | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
  /** Перечитать кривую без ошибки: показания за окно могли дописаться. */
  readonly refetchSeries: () => void;
}

/** Данные графика строки: эпизоды обоих вариантов и кривая параметра за окно прогона. */
export const useRowChart = (run: ReplayRun, row: ReplayDiffRow): RowChartData => {
  const key = { deviceCode: row.deviceCode, metricKey: row.metricKey, mode: row.mode };

  const episodes = useQuery({
    queryKey: queryKeys.replayEpisodes(run.id, key),
    queryFn: () => api.replayEpisodes(run.id, key),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const series = useQuery({
    queryKey: queryKeys.series(row.deviceCode, [row.metricKey], run.from, run.to),
    queryFn: () =>
      api.series(row.deviceCode, {
        metrics: [row.metricKey],
        from: run.from,
        to: run.to,
        maxPoints: MAX_POINTS,
      }),
  });

  return {
    episodes: episodes.data,
    series: series.data,
    isPending: episodes.isPending || series.isPending,
    isError: episodes.isError || series.isError,
    error: episodes.error ?? series.error,
    refetch: () => {
      if (episodes.isError) void episodes.refetch();
      if (series.isError) void series.refetch();
    },
    refetchSeries: () => {
      void series.refetch();
    },
  };
};
