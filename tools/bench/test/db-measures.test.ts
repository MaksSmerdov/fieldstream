import { pickSource } from '@fieldstream/contracts';
import { describe, expect, it } from 'vitest';
import { compressionFactsOf, compressionRowsOf } from '../src/measures/compression.js';
import {
  bucketFor,
  bucketText,
  explainSql,
  planFactsOf,
  planNoteOf,
  seriesSql,
  targetOf,
} from '../src/measures/query.js';

const MIB = 1_048_576;

const statsCells = {
  compressed: '8',
  uncompressed: '1',
  before_bytes: String(300 * MIB),
  after_bytes: String(12 * MIB),
  ratio: '25',
};

const plan = [
  'Sort  (cost=427.87..429.53 rows=663 width=52) (actual time=5.377..5.436 rows=1785 loops=1)',
  '  Sort Key: r_1.metric_key',
  '  Buffers: shared hit=406',
  '  ->  HashAggregate  (cost=386.86..396.80 rows=663 width=52) (actual time=4.727..4.868 rows=1785 loops=1)',
  '        Buffers: shared hit=400',
  '        ->  Custom Scan (DecompressChunk) on _hyper_8_36_chunk r_1  (cost=2.59..5.18 rows=2000 width=32) (actual time=0.114..0.176 rows=1281 loops=1)',
  '              ->  Index Scan using compress_hyper_9_52_chunk_device_id_idx on compress_hyper_9_52_chunk  (cost=0.27..5.18 rows=2 width=100) (actual time=0.014..0.021 rows=3 loops=1)',
  '        ->  Custom Scan (DecompressChunk) on _hyper_8_37_chunk r_2  (cost=2.09..6.27 rows=3000 width=32) (actual time=0.084..0.233 rows=4320 loops=1)',
  '        ->  Bitmap Heap Scan on _hyper_8_56_chunk r_3  (cost=8.53..208.99 rows=261 width=32) (actual time=0.072..0.453 rows=522 loops=1)',
  'Planning:',
  '  Buffers: shared hit=1714',
  'Planning Time: 2.209 ms',
  'Execution Time: 5.629 ms',
];

const target = {
  deviceCode: 'PM-201',
  metricKeys: ['active_power_kw', 'current_l1_a'],
  from: '2026-09-14 16:52:37.564+00',
  to: '2026-09-21 16:52:37.564+00',
};

describe('цифры сжатия ts.readings', () => {
  it('складываются из ячеек chunk_compression_stats', () => {
    expect(compressionFactsOf(statsCells)).toEqual({
      compressed: 8,
      uncompressed: 1,
      beforeBytes: 300 * MIB,
      afterBytes: 12 * MIB,
      ratio: 25,
    });
  });

  it('пустая статистика это ноль кусков и нечего делить', () => {
    expect(compressionFactsOf(undefined)).toEqual({
      compressed: 0,
      uncompressed: 0,
      beforeBytes: null,
      afterBytes: null,
      ratio: null,
    });
  });

  it('дают коэффициент, куски, объёмы и отыгранное место', () => {
    const rows = compressionRowsOf(compressionFactsOf(statsCells), 'psql -c ...');

    expect(rows.map((row) => `${row.label}: ${row.value}`)).toEqual([
      'коэффициент сжатия ts.readings: 25.0x',
      'кусков сжато: 8',
      'кусков не сжато: 1',
      'объём кусков до сжатия: 300.0 МиБ',
      'объём кусков после сжатия: 12.0 МиБ',
      'сжатие отыграло: 288.0 МиБ (96.0 %)',
    ]);
  });

  it('у каждой строки есть непустая команда повтора', () => {
    const rows = compressionRowsOf(compressionFactsOf(statsCells), 'psql -c ...');

    expect(rows.every((row) => row.how.trim().length > 0)).toBe(true);
  });

  it('без сжатых кусков коэффициента и объёмов нет, а цифра не выдумывается', () => {
    const facts = compressionFactsOf({
      compressed: '0',
      uncompressed: '1',
      before_bytes: null,
      after_bytes: null,
      ratio: null,
    });
    const rows = compressionRowsOf(facts, 'psql -c ...');

    expect(rows[0]?.value).toBe('сжатых кусков нет');
    expect(rows[3]?.value).toBe('нет данных');
    expect(rows[5]?.value).toBe('нет данных');
  });
});

describe('шаг агрегации источника', () => {
  it('для выбранного источника совпадает с pickSource', () => {
    for (const rangeMs of [3_600_000, 6 * 3_600_000, 24 * 3_600_000, 7 * 24 * 3_600_000]) {
      const chosen = pickSource(rangeMs);
      expect(bucketFor(chosen.source, rangeMs)).toBe(chosen.bucketMs);
    }
  });

  it('не бывает мельче разрешения источника', () => {
    expect(bucketFor('readings', 60_000)).toBe(10_000);
    expect(bucketFor('readings_1m', 60_000)).toBe(60_000);
    expect(bucketFor('readings_1h', 7 * 24 * 3_600_000)).toBe(3_600_000);
  });

  it('пишется часами, минутами или секундами по кратности', () => {
    expect(bucketText(3_600_000)).toBe('1 ч');
    expect(bucketText(360_000)).toBe('6 мин');
    expect(bucketText(310_000)).toBe('310 с');
  });
});

describe('запрос серии', () => {
  it('для сырых строк читает ts.readings и считает обычное среднее', () => {
    const sql = seriesSql({ ...target, source: 'readings', bucketMs: 310_000 });

    expect(sql).toContain('FROM ts.readings r');
    expect(sql).toContain('avg(r.value) AS avg');
    expect(sql).toContain("time_bucket('310000 milliseconds'::interval, r.ts)");
    expect(sql).toContain("r.metric_key = ANY('{active_power_kw,current_l1_a}'::text[])");
    expect(sql).toContain("r.ts >= '2026-09-14 16:52:37.564+00'");
  });

  it('для агрегатов читает представления и считает средневзвешенное по числу отсчётов', () => {
    const minute = seriesSql({ ...target, source: 'readings_1m', bucketMs: 360_000 });
    const hour = seriesSql({ ...target, source: 'readings_1h', bucketMs: 3_600_000 });

    expect(minute).toContain('FROM ts.v_readings_1m v');
    expect(hour).toContain('FROM ts.v_readings_1h v');
    expect(minute).toContain('sum(v.avg_value * v.n) / NULLIF(sum(v.n), 0) AS avg');
    expect(hour).toContain("v.bucket < '2026-09-21 16:52:37.564+00'");
  });

  it('идёт одной строкой и удваивает кавычку в коде прибора', () => {
    const sql = seriesSql({
      ...target,
      deviceCode: "O'Hara",
      source: 'readings',
      bucketMs: 10_000,
    });

    expect(sql).not.toContain('\n');
    expect(sql).toContain("d.code = 'O''Hara'");
  });

  it('под EXPLAIN уходит тот же текст с разбором плана и буферами', () => {
    const sql = seriesSql({ ...target, source: 'readings', bucketMs: 10_000 });

    expect(explainSql(sql)).toBe(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
  });
});

describe('разбор плана', () => {
  it('берёт время, точки ответа, буферы верхнего узла и куски без внутренних кусков сжатия', () => {
    expect(planFactsOf(plan)).toEqual({
      executionMs: 5.629,
      planningMs: 2.209,
      points: 1785,
      buffers: 'shared hit=406',
      chunks: 3,
    });
  });

  it('пустой план ничего не выдумывает', () => {
    expect(planFactsOf([])).toEqual({
      executionMs: null,
      planningMs: null,
      points: null,
      buffers: null,
      chunks: 0,
    });
  });

  it('оговорка собирается только из того, что в плане нашлось', () => {
    expect(planNoteOf(planFactsOf(plan))).toBe(
      'планирование 2.2 мс, точек в ответе 1 785, кусков прочитано 3, буферы shared hit=406',
    );
    expect(planNoteOf(planFactsOf([]))).toBe('кусков прочитано 0');
  });
});

describe('цель замера запроса', () => {
  it('разбирает прибор, метрики списком и концы окна', () => {
    expect(
      targetOf({
        device_code: 'PM-201',
        metric_keys: 'active_power_kw,current_l1_a',
        from_ts: '2026-09-14 16:52:37.564+00',
        to_ts: '2026-09-21 16:52:37.564+00',
      }),
    ).toEqual(target);
  });

  it('без прибора со свежими значениями замерять нечего', () => {
    expect(() => targetOf(undefined)).toThrow(/не нашлось прибора/);
  });

  it('прибор без описанных метрик тоже не годится', () => {
    expect(() =>
      targetOf({
        device_code: 'PM-201',
        metric_keys: null,
        from_ts: '2026-09-14 16:52:37.564+00',
        to_ts: '2026-09-21 16:52:37.564+00',
      }),
    ).toThrow(/не нашлось прибора/);
  });
});
