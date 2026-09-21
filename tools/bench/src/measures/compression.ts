import { literal, oneLine } from '../db.js';
import { formatBytes, formatNumber, formatPercent, formatRatio, numberOf } from '../stats.js';
import type { Bench, Cells, Measure, MeasureResult, Row } from '../measure.js';

/** Гипертаблица, сжатие которой снимается: её куски и есть основной объём стенда. */
const TABLE = 'ts.readings';

/**
 * Статистика сжатия по кускам. Только chunk_compression_stats: по hypertable_detailed_size
 * коэффициент выходит вдвое ниже, потому что в общий объём попадают горячие несжатые сутки
 * и индексы, а здесь на каждый кусок стоят его собственные объёмы до и после.
 */
const STATS_SQL = oneLine(`
  SELECT count(*) FILTER (WHERE compression_status = 'Compressed') AS compressed,
         count(*) FILTER (WHERE compression_status <> 'Compressed') AS uncompressed,
         sum(before_compression_total_bytes) AS before_bytes,
         sum(after_compression_total_bytes) AS after_bytes,
         sum(before_compression_total_bytes)::numeric
           / NULLIF(sum(after_compression_total_bytes), 0) AS ratio
  FROM chunk_compression_stats(${literal(TABLE)})`);

/** Ячейки выборки сжатия: объёмы и коэффициент пустые, пока не сжат ни один кусок. */
type CompressionCells = Cells & {
  readonly compressed: string | null;
  readonly uncompressed: string | null;
  readonly before_bytes: string | null;
  readonly after_bytes: string | null;
  readonly ratio: string | null;
};

/** Цифры сжатия: сколько кусков сжато, сколько нет, объём до и после и коэффициент. */
export interface CompressionFacts {
  readonly compressed: number;
  readonly uncompressed: number;
  readonly beforeBytes: number | null;
  readonly afterBytes: number | null;
  readonly ratio: number | null;
}

/** Ячейки выборки в цифры сжатия: пустая статистика это ноль кусков и нечего делить. */
export const compressionFactsOf = (cells: Cells | undefined): CompressionFacts => ({
  compressed: numberOf(cells?.['compressed']) ?? 0,
  uncompressed: numberOf(cells?.['uncompressed']) ?? 0,
  beforeBytes: numberOf(cells?.['before_bytes']),
  afterBytes: numberOf(cells?.['after_bytes']),
  ratio: numberOf(cells?.['ratio']),
});

/** Объём словами: у несжатых кусков объёмов нет вовсе, и выдумывать ноль нельзя. */
const sizeText = (bytes: number | null): string =>
  bytes === null ? 'нет данных' : formatBytes(bytes);

/** Сколько места отыграло сжатие: объём и доля от исходного. */
const savedText = (facts: CompressionFacts): string => {
  const { beforeBytes, afterBytes } = facts;
  if (beforeBytes === null || afterBytes === null || beforeBytes === 0) return 'нет данных';

  const saved = beforeBytes - afterBytes;
  return `${formatBytes(saved)} (${formatPercent(saved / beforeBytes)})`;
};

/** Строки таблицы по цифрам сжатия: how у всех один, эта выборка отдаёт все цифры разом. */
export const compressionRowsOf = (facts: CompressionFacts, how: string): Row[] => [
  {
    label: `коэффициент сжатия ${TABLE}`,
    value: facts.ratio === null ? 'сжатых кусков нет' : formatRatio(facts.ratio),
    how,
    note: 'считается только по сжатым кускам: у несжатых chunk_compression_stats объёмы не заполняет',
  },
  { label: 'кусков сжато', value: formatNumber(facts.compressed), how },
  {
    label: 'кусков не сжато',
    value: formatNumber(facts.uncompressed),
    how,
    note: 'политика сжимает куски старше двух суток, поэтому горячие сутки остаются несжатыми всегда',
  },
  { label: 'объём кусков до сжатия', value: sizeText(facts.beforeBytes), how },
  { label: 'объём кусков после сжатия', value: sizeText(facts.afterBytes), how },
  { label: 'сжатие отыграло', value: savedText(facts), how },
];

/** Наблюдение по ходу замера: что с чем сравнивается и сколько кусков за этим стоит. */
const observationOf = (facts: CompressionFacts): string =>
  `сжато ${formatNumber(facts.compressed)} кусков из ` +
  `${formatNumber(facts.compressed + facts.uncompressed)}, ` +
  `${sizeText(facts.beforeBytes)} ужались до ${sizeText(facts.afterBytes)}`;

/** Снимает сжатие ts.readings: одна выборка по chunk_compression_stats, дальше только счёт. */
const run = async (bench: Bench): Promise<MeasureResult> => {
  const [cells] = await bench.db.rows<CompressionCells>(STATS_SQL);
  const facts = compressionFactsOf(cells);

  if (facts.compressed + facts.uncompressed === 0) {
    throw new Error(
      `chunk_compression_stats(${TABLE}) не вернул ни одного куска: гипертаблица пуста ` +
        'или статистика сжатия этой роли не видна',
    );
  }
  bench.observe(observationOf(facts));

  return {
    rows: compressionRowsOf(facts, bench.db.how(STATS_SQL)),
    note:
      'цифра снята по chunk_compression_stats, а не по hypertable_detailed_size: в общий объём ' +
      'гипертаблицы попадают горячие несжатые сутки и индексы, и коэффициент на них занижается вдвое',
  };
};

export const compression: Measure = {
  name: 'compression',
  title: 'сжатие ts.readings: коэффициент, куски и объём до и после',
  needs: ['db'],
  run,
};
