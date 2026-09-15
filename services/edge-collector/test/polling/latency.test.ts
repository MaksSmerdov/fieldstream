import { describe, expect, it } from 'vitest';
import { latencyWindowSchema } from '@fieldstream/contracts';
import {
  LATENCY_BUCKETS_MS,
  LATENCY_WINDOW_SIZE,
  createLatencyTracker,
  summarizeLatency,
} from '../../src/polling/latency.js';
import type { RequestOutcome } from '../../src/polling/latency.js';

/** Успешные запросы с заданными длительностями. */
const oks = (durations: readonly number[]): RequestOutcome[] =>
  durations.map((durationMs) => ({ kind: 'ok', durationMs }));

/** Длительности от from до to включительно. */
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_value, index) => from + index);

describe('окно времени ответа', () => {
  it('перцентили считаются методом ближайшего ранга', () => {
    const window = summarizeLatency(oks(range(1, 100).reverse()));

    expect(window).toMatchObject({ samples: 100, p50Ms: 50, p95Ms: 95, p99Ms: 99 });
    expect(latencyWindowSchema.parse(window)).toEqual(window);
  });

  it('корзины по границам включительно, всё сверх последней границы в отдельной корзине', () => {
    const window = summarizeLatency(oks([10, 25, 26, 1_200, 1_201, 5_000]));

    expect(window.bucketsMs).toEqual([...LATENCY_BUCKETS_MS]);
    expect(window.counts).toHaveLength(LATENCY_BUCKETS_MS.length + 1);
    expect(window.counts).toEqual([2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
    expect(window.p99Ms).toBe(5_000);
  });

  it('таймауты считаются отдельно и в перцентили не попадают', () => {
    const empty = summarizeLatency([{ kind: 'timeout' }, { kind: 'timeout' }]);

    expect(empty).toMatchObject({
      samples: 0,
      timeouts: 2,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      suggestedTimeoutMs: null,
    });
    expect(empty.counts.every((count) => count === 0)).toBe(true);

    const mixed = summarizeLatency([...oks([40, 60]), { kind: 'timeout' }]);
    expect(mixed).toMatchObject({ samples: 2, timeouts: 1, p50Ms: 40, p99Ms: 60 });
  });

  it('рекомендация таймаута появляется только со ста замеров', () => {
    expect(summarizeLatency(oks(range(102, 200))).suggestedTimeoutMs).toBeNull();

    const enough = summarizeLatency(oks(range(101, 200)));
    expect(enough).toMatchObject({ samples: 100, p99Ms: 199, suggestedTimeoutMs: 1_000 });

    const fast = summarizeLatency(oks(Array.from({ length: 100 }, () => 50)));
    expect(fast).toMatchObject({ samples: 100, p99Ms: 50, suggestedTimeoutMs: 500 });
  });

  it('окно держит последние исходы, старые вытесняются', () => {
    const tracker = createLatencyTracker();
    tracker.record({ kind: 'timeout' });
    for (let index = 0; index < LATENCY_WINDOW_SIZE; index += 1) {
      tracker.record({ kind: 'ok', durationMs: index === 0 ? 5_000 : 30 });
    }

    expect(tracker.summary()).toMatchObject({ samples: LATENCY_WINDOW_SIZE, timeouts: 0 });

    tracker.record({ kind: 'ok', durationMs: 30 });
    const window = tracker.summary();
    expect(window.counts[1]).toBe(LATENCY_WINDOW_SIZE);
    expect(window.counts.at(-1)).toBe(0);
  });
});
