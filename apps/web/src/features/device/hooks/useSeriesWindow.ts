import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ModeSpan, SeriesMeta, SeriesMetric } from '@fieldstream/contracts';
import { api } from '../../../shared/api/endpoints.js';
import { queryKeys } from '../../../shared/api/query-keys.js';
import { getServerNowMs } from '../../../shared/time/serverClock.js';

export type WindowKey = '1h' | '6h' | '24h' | '7d';

export const WINDOW_LABEL: Readonly<Record<WindowKey, string>> = {
  '1h': 'час',
  '6h': '6 часов',
  '24h': 'сутки',
  '7d': 'неделя',
};

const WINDOW_MS: Readonly<Record<WindowKey, number>> = {
  '1h': 3_600_000,
  '6h': 21_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
};

/**
 * Насколько крупно сдвигается правый край окна. Двигать его каждую секунду нельзя: ключ
 * запроса менялся бы на каждом кадре, и окно перезапрашивалось бы чаще, чем данные вообще
 * появляются.
 */
const STEP_MS: Readonly<Record<WindowKey, number>> = {
  '1h': 60_000,
  '6h': 300_000,
  '24h': 900_000,
  '7d': 3_600_000,
};

const TICK_MS = 15_000;
const MAX_POINTS = 800;

export interface SeriesWindow {
  readonly from: string;
  readonly to: string;
  /** Точки хоть раз пришли: неудачный перезапрос не повод убирать график с экрана. */
  readonly hasData: boolean;
  readonly metrics: readonly SeriesMetric[];
  readonly meta: SeriesMeta | undefined;
  readonly spans: readonly ModeSpan[];
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

/** Правый край окна, выровненный по шагу: пока шаг не прошёл, ключ запроса не меняется. */
const edgeOf = (key: WindowKey, nowMs: number): number =>
  Math.floor(nowMs / STEP_MS[key]) * STEP_MS[key];

export const useSeriesWindow = (
  code: string,
  metricKeys: readonly string[],
  key: WindowKey,
): SeriesWindow => {
  const [edgeMs, setEdgeMs] = useState(() => edgeOf(key, getServerNowMs()));

  useEffect(() => {
    setEdgeMs(edgeOf(key, getServerNowMs()));
    const timer = setInterval(() => {
      setEdgeMs(edgeOf(key, getServerNowMs()));
    }, TICK_MS);

    return () => {
      clearInterval(timer);
    };
  }, [key]);

  const { from, to } = useMemo(
    () => ({
      from: new Date(edgeMs - WINDOW_MS[key]).toISOString(),
      to: new Date(edgeMs).toISOString(),
    }),
    [edgeMs, key],
  );

  const metrics = useMemo(() => [...metricKeys].sort(), [metricKeys]);
  const enabled = metrics.length > 0;

  // Правый край окна двигается сам, и ключ запроса при этом меняется. Без переноса прежних
  // точек график на секунду заменялся бы заглушкой каждую минуту, хотя данные почти те же
  const series = useQuery({
    queryKey: queryKeys.series(code, metrics, from, to),
    queryFn: () => api.series(code, { metrics, from, to, maxPoints: MAX_POINTS }),
    enabled,
    placeholderData: keepPreviousData,
  });

  const events = useQuery({
    queryKey: queryKeys.deviceEvents(code, from, to),
    queryFn: () => api.deviceEvents(code, { from, to }),
    placeholderData: keepPreviousData,
  });

  return {
    from,
    to,
    hasData: series.data !== undefined || !enabled,
    metrics: series.data?.metrics ?? [],
    meta: series.data?.meta,
    spans: events.data?.spans ?? [],
    isPending: (enabled && series.isPending) || events.isPending,
    isError: series.isError || events.isError,
    error: series.error ?? events.error,
    refetch: () => {
      void series.refetch();
      void events.refetch();
    },
  };
};
