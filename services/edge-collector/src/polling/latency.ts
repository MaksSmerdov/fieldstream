import type { LatencyWindow } from '@fieldstream/contracts';

export const LATENCY_BUCKETS_MS: readonly number[] = Object.freeze([
  25, 50, 75, 100, 150, 200, 300, 400, 600, 800, 1_200,
]);

export const LATENCY_WINDOW_SIZE = 2_000;

export const MIN_SAMPLES_FOR_TIMEOUT_HINT = 100;

export type RequestOutcome =
  { readonly kind: 'ok'; readonly durationMs: number } | { readonly kind: 'timeout' };

export interface LatencyTracker {
  readonly record: (outcome: RequestOutcome) => void;
  readonly summary: () => LatencyWindow;
}

/** Перцентиль методом ближайшего ранга по отсортированным замерам. */
export const nearestRank = (sorted: readonly number[], percentile: number): number | null => {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
};

/** Рекомендуемый таймаут: пять p99 с округлением вверх до сотни, не меньше 500 мс. */
export const suggestTimeoutMs = (p99Ms: number | null, samples: number): number | null => {
  if (p99Ms === null || samples < MIN_SAMPLES_FOR_TIMEOUT_HINT) return null;
  return Math.max(500, Math.ceil((p99Ms * 5) / 100) * 100);
};

/** Сводка окна: корзины, перцентили и рекомендация таймаута по успешным длительностям. */
export const summarizeLatency = (outcomes: readonly RequestOutcome[]): LatencyWindow => {
  const counts = new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0);
  const durations: number[] = [];
  let timeouts = 0;

  for (const outcome of outcomes) {
    if (outcome.kind === 'timeout') {
      timeouts += 1;
      continue;
    }
    const durationMs = Math.max(0, Math.round(outcome.durationMs));
    const bucket = LATENCY_BUCKETS_MS.findIndex((bound) => durationMs <= bound);
    const index = bucket === -1 ? LATENCY_BUCKETS_MS.length : bucket;
    counts[index] = (counts[index] ?? 0) + 1;
    durations.push(durationMs);
  }

  const sorted = durations.sort((left, right) => left - right);
  const p99Ms = nearestRank(sorted, 99);

  return {
    bucketsMs: [...LATENCY_BUCKETS_MS],
    counts,
    samples: sorted.length,
    timeouts,
    p50Ms: nearestRank(sorted, 50),
    p95Ms: nearestRank(sorted, 95),
    p99Ms,
    suggestedTimeoutMs: suggestTimeoutMs(p99Ms, sorted.length),
  };
};

/** Кольцевое окно последних исходов: самые старые вытесняются новыми. */
export const createLatencyTracker = (capacity = LATENCY_WINDOW_SIZE): LatencyTracker => {
  const outcomes: RequestOutcome[] = [];
  let next = 0;

  return {
    record: (outcome) => {
      if (outcomes.length < capacity) {
        outcomes.push(outcome);
        return;
      }
      outcomes[next] = outcome;
      next = (next + 1) % capacity;
    },
    summary: () => summarizeLatency(outcomes),
  };
};
