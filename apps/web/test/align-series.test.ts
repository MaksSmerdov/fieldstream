import { describe, expect, it } from 'vitest';
import type { SeriesMetric } from '@fieldstream/contracts';
import { alignSeries } from '../src/shared/charts/align-series.js';

const point = (t: string, avg: number | null) => ({
  t,
  avg,
  min: avg,
  max: avg,
  n: avg === null ? 0 : 1,
});

const supply: SeriesMetric = {
  metricKey: 'supply_temp_c',
  points: [
    point('2026-02-11T10:00:00.000Z', -18.2),
    point('2026-02-11T10:01:00.000Z', -18.4),
    point('2026-02-11T10:02:00.000Z', -18.1),
  ],
};

/** У обратки нет точки в первой минуте: прибор её в этот бакет не отдал. */
const back: SeriesMetric = {
  metricKey: 'return_temp_c',
  points: [point('2026-02-11T10:01:00.000Z', -12.5), point('2026-02-11T10:02:00.000Z', -12.6)],
};

describe('общая шкала графика', () => {
  it('шкала это объединение моментов, а пропуск остаётся пропуском', () => {
    const { xs, ys } = alignSeries([supply, back]);

    expect(xs).toEqual([
      Date.parse('2026-02-11T10:00:00.000Z') / 1000,
      Date.parse('2026-02-11T10:01:00.000Z') / 1000,
      Date.parse('2026-02-11T10:02:00.000Z') / 1000,
    ]);
    expect(ys[0]).toEqual([-18.2, -18.4, -18.1]);
    expect(ys[1]).toEqual([null, -12.5, -12.6]);
  });

  it('моменты идут по возрастанию, даже если ответ пришёл вперемешку', () => {
    const shuffled: SeriesMetric = {
      metricKey: 'superheat_k',
      points: [point('2026-02-11T10:02:00.000Z', 3), point('2026-02-11T10:00:00.000Z', 1)],
    };

    const { xs, ys } = alignSeries([shuffled]);

    expect(xs[0]).toBeLessThan(xs[1] ?? 0);
    expect(ys[0]).toEqual([1, 3]);
  });

  it('дыра в данных остаётся пустой, а не нулём', () => {
    const withGap: SeriesMetric = {
      metricKey: 'evap_temp_c',
      points: [point('2026-02-11T10:00:00.000Z', null), point('2026-02-11T10:01:00.000Z', -20)],
    };

    expect(alignSeries([withGap]).ys[0]).toEqual([null, -20]);
  });

  it('часы без точек разрывают кривую пустой точкой, а короткий пропуск бакета нет', () => {
    const minute = 60_000;
    const outage: SeriesMetric = {
      metricKey: 'evap_temp_c',
      points: [
        point('2026-02-11T10:00:00.000Z', -25),
        point('2026-02-11T10:02:00.000Z', -25),
        point('2026-02-11T13:00:00.000Z', -25),
      ],
    };

    const { xs, ys } = alignSeries([outage], minute);

    expect(xs).toEqual(
      [
        '2026-02-11T10:00:00.000Z',
        '2026-02-11T10:02:00.000Z',
        '2026-02-11T10:03:00.000Z',
        '2026-02-11T13:00:00.000Z',
      ].map((t) => Date.parse(t) / 1000),
    );
    expect(ys[0]).toEqual([-25, -25, null, -25]);
    expect(alignSeries([outage]).ys[0]).toEqual([-25, -25, -25]);
  });

  it('пустой ответ даёт пустую шкалу, а не одну точку', () => {
    expect(alignSeries([{ metricKey: 'supply_temp_c', points: [] }])).toEqual({
      xs: [],
      ys: [[]],
    });
  });
});
