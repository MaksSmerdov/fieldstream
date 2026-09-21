import { MAX_SERIES_POINTS, pickSource } from '@fieldstream/contracts';
import type { SeriesPlan, SeriesSource } from '@fieldstream/contracts';
import { literal, oneLine } from '../db.js';
import { formatDuration, formatNumber, numberOf } from '../stats.js';
import type { Bench, Cells, Measure, MeasureResult, Row } from '../measure.js';

/**
 * Окно замера. Семь суток это верхняя граница полосы readings_1m в pickSource, поэтому на нём
 * осмысленны все три источника разом: сырые строки ещё не вышли за срок хранения в тридцать
 * суток, а оба агрегата на таком окне уже материализованы.
 */
const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * 24 * 3_600_000;
const WINDOW_TEXT = `${WINDOW_DAYS} суток`;

/** Источники серии в порядке огрубления: сырые строки, минутный агрегат, часовой. */
const SOURCES: readonly SeriesSource[] = ['readings', 'readings_1m', 'readings_1h'];

/** Разрешение источника: шаг мельче него смысла не имеет, так же считает и pickSource. */
const SOURCE_MIN_MS: Readonly<Record<SeriesSource, number>> = {
  readings: 10_000,
  readings_1m: 60_000,
  readings_1h: 3_600_000,
};

/** Имя источника в схеме: агрегаты читаются через представления со средним значением. */
const SOURCE_RELATION: Readonly<Record<SeriesSource, string>> = {
  readings: 'ts.readings',
  readings_1m: 'ts.v_readings_1m',
  readings_1h: 'ts.v_readings_1h',
};

/** Где лежит правило выбора источника: этой командой его читают глазами. */
const RULE_HOW = "sed -n '/export const pickSource/,/^};/p' packages/contracts/src/series.ts";

/**
 * Прибор со свежими значениями, три его метрики и границы окна по часам базы. Часы контейнера
 * и хоста расходятся, поэтому концы окна берутся у самой базы и дальше идут в запрос готовыми
 * отметками: так и план строится по константам, и человек повторяет замер на том же окне.
 */
const TARGET_SQL = oneLine(`
  SELECT d.code AS device_code, m.metric_keys,
         (now() - INTERVAL '${WINDOW_DAYS} days')::text AS from_ts,
         now()::text AS to_ts
  FROM core.devices d
  JOIN LATERAL (
    SELECT string_agg(k.metric_key, ',' ORDER BY k.metric_key) AS metric_keys
    FROM (SELECT metric_key FROM core.metric_defs
          WHERE profile_key = d.profile_key ORDER BY metric_key LIMIT 3) k
  ) m ON true
  WHERE EXISTS (SELECT 1 FROM ts.readings r
                WHERE r.device_id = d.id AND r.ts > now() - INTERVAL '1 hour')
  ORDER BY d.code LIMIT 1`);

/** Ячейки выборки цели: прибор, метрики списком через запятую и концы окна. */
type TargetCells = Cells & {
  readonly device_code: string | null;
  readonly metric_keys: string | null;
  readonly from_ts: string | null;
  readonly to_ts: string | null;
};

/** Ячейка вывода EXPLAIN: сервер отдаёт план по строке на узел. */
type PlanCells = Cells & { readonly 'QUERY PLAN': string | null };

/** Шаг агрегации источника на заданном окне: тот же расчёт, что в pickSource. */
export const bucketFor = (source: SeriesSource, rangeMs: number): number => {
  const min = SOURCE_MIN_MS[source];

  return Math.max(min, Math.ceil(rangeMs / MAX_SERIES_POINTS / min) * min);
};

/** Шаг словами: часы, минуты или секунды, смотря на что он кратен. */
export const bucketText = (ms: number): string => {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} ч`;
  if (ms % 60_000 === 0) return `${ms / 60_000} мин`;

  return `${ms / 1_000} с`;
};

/** Что спрашивается у источника: прибор, метрики, концы окна и шаг агрегации. */
export interface SeriesQuery {
  readonly source: SeriesSource;
  readonly deviceCode: string;
  readonly metricKeys: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly bucketMs: number;
}

/**
 * Запрос серии тем же текстом, каким его шлёт loadSeries (packages/db/src/store/read.ts): там
 * значения идут отдельными параметрами, здесь они вписаны в текст, потому что этот же текст
 * уходит в how и человек вставляет его в psql как есть.
 */
export const seriesSql = (request: SeriesQuery): string => {
  const bucket = literal(`${request.bucketMs} milliseconds`);
  const keys = literal(`{${request.metricKeys.join(',')}}`);
  const device = literal(request.deviceCode);
  const from = literal(request.from);
  const to = literal(request.to);

  return oneLine(
    request.source === 'readings'
      ? `SELECT time_bucket(${bucket}::interval, r.ts) AS bucket, r.metric_key,
                avg(r.value) AS avg, min(r.value) AS min, max(r.value) AS max,
                count(r.value) AS n
         FROM ts.readings r
         JOIN core.devices d ON d.id = r.device_id
         WHERE d.code = ${device} AND r.metric_key = ANY(${keys}::text[])
           AND r.ts >= ${from} AND r.ts < ${to}
         GROUP BY 1, 2 ORDER BY 2, 1`
      : `SELECT time_bucket(${bucket}::interval, v.bucket) AS bucket, v.metric_key,
                sum(v.avg_value * v.n) / NULLIF(sum(v.n), 0) AS avg,
                min(v.min_value) AS min, max(v.max_value) AS max, sum(v.n) AS n
         FROM ${SOURCE_RELATION[request.source]} v
         JOIN core.devices d ON d.id = v.device_id
         WHERE d.code = ${device} AND v.metric_key = ANY(${keys}::text[])
           AND v.bucket >= ${from} AND v.bucket < ${to}
         GROUP BY 1, 2 ORDER BY 2, 1`,
  );
};

/** Запрос под разбор плана: ANALYZE выполняет тот же SELECT, данные при этом не меняются. */
export const explainSql = (sql: string): string => `EXPLAIN (ANALYZE, BUFFERS) ${oneLine(sql)}`;

/** Что взято из плана: время, число точек ответа, буферы и сколько кусков пришлось читать. */
export interface PlanFacts {
  readonly executionMs: number | null;
  readonly planningMs: number | null;
  readonly points: number | null;
  readonly buffers: string | null;
  readonly chunks: number;
}

/**
 * Разбор вывода EXPLAIN. Первая строка Buffers относится к верхнему узлу и уже включает
 * потомков, поэтому берётся именно она, а куски считаются по именам без повторов: их число
 * и показывает, отсеклись ли лишние куски гипертаблицы по границам окна. Внутренние куски
 * сжатия (compress_hyper_…) в счёт не идут, иначе один сжатый кусок считался бы дважды.
 */
export const planFactsOf = (plan: readonly string[]): PlanFacts => {
  const text = plan.join('\n');
  const execution = /^Execution Time: ([\d.]+) ms/m.exec(text);
  const planning = /^Planning Time: ([\d.]+) ms/m.exec(text);
  const points = /actual time=[\d.]+\.\.[\d.]+ rows=(\d+) loops=/.exec(text);
  const buffers = /^\s*Buffers: (.+)$/m.exec(text);

  return {
    executionMs: numberOf(execution?.[1]),
    planningMs: numberOf(planning?.[1]),
    points: numberOf(points?.[1]),
    buffers: buffers?.[1]?.trim() ?? null,
    chunks: new Set(text.match(/(?<!\w)_hyper_\d+_\d+_chunk/g) ?? []).size,
  };
};

/** Оговорка к строке источника: чем оплачено время, которое стоит в величине. */
export const planNoteOf = (facts: PlanFacts): string => {
  const parts = [
    facts.planningMs === null ? null : `планирование ${formatDuration(facts.planningMs)}`,
    facts.points === null ? null : `точек в ответе ${formatNumber(facts.points)}`,
    `кусков прочитано ${formatNumber(facts.chunks)}`,
    facts.buffers === null ? null : `буферы ${facts.buffers}`,
  ];

  return parts.filter((part): part is string => part !== null).join(', ');
};

/** Правило выбора источника словами: пороги те же, что в pickSource. */
const ruleRow = (plan: SeriesPlan): Row => ({
  label: 'правило выбора источника',
  value: `окно ${WINDOW_TEXT} даёт ${plan.source}, шаг ${bucketText(plan.bucketMs)}`,
  how: RULE_HOW,
  note:
    'до шести часов идут сырые readings, до семи суток агрегат readings_1m, дальше readings_1h; ' +
    'шаг округляется вверх до кратного разрешению источника, иначе бакеты не сойдутся с материализованными',
});

/** Цель замера: прибор со свежими значениями, его метрики и концы окна по часам базы. */
export interface Target {
  readonly deviceCode: string;
  readonly metricKeys: readonly string[];
  readonly from: string;
  readonly to: string;
}

/** Ячейки выборки цели в цель замера: без прибора, метрик и окна замерять нечего. */
export const targetOf = (cells: TargetCells | undefined): Target => {
  const deviceCode = cells?.device_code ?? null;
  const from = cells?.from_ts ?? null;
  const to = cells?.to_ts ?? null;
  const metricKeys = (cells?.metric_keys ?? '').split(',').filter((key) => key !== '');

  if (deviceCode === null || from === null || to === null || metricKeys.length === 0) {
    throw new Error(
      'на стенде не нашлось прибора со свежими значениями и описанными метриками: ' +
        'замер запроса серии не на чем ставить',
    );
  }

  return { deviceCode, metricKeys, from, to };
};

/** Источник с разобранным планом: по этим парам и сравнивается цена выбора. */
interface Measured {
  readonly source: SeriesSource;
  readonly facts: PlanFacts;
}

/** Наблюдение по ходу замера: во что обходится крайний выбор источника. */
const observationOf = (measured: readonly Measured[]): string => {
  const timed = measured
    .flatMap((item) =>
      item.facts.executionMs === null ? [] : [{ source: item.source, ms: item.facts.executionMs }],
    )
    .sort((left, right) => left.ms - right.ms);
  const fastest = timed[0];
  const slowest = timed[timed.length - 1];
  if (fastest === undefined || slowest === undefined) {
    return 'ни один план не отдал время выполнения';
  }

  return (
    `на одном окне быстрее всех ${fastest.source} (${formatDuration(fastest.ms)}), ` +
    `медленнее всех ${slowest.source} (${formatDuration(slowest.ms)})`
  );
};

/** Снимает цену выбора источника: один и тот же запрос серии под EXPLAIN по трём источникам. */
const run = async (bench: Bench): Promise<MeasureResult> => {
  const [cells] = await bench.db.rows<TargetCells>(TARGET_SQL);
  const target = targetOf(cells);
  const plan = pickSource(WINDOW_MS);
  const rows: Row[] = [ruleRow(plan)];
  const measured: Measured[] = [];

  for (const source of SOURCES) {
    const bucketMs = bucketFor(source, WINDOW_MS);
    const explain = explainSql(seriesSql({ ...target, source, bucketMs }));
    const output = await bench.db.rows<PlanCells>(explain);
    const facts = planFactsOf(output.map((line) => line['QUERY PLAN'] ?? ''));

    measured.push({ source, facts });
    rows.push({
      label: `${SOURCE_RELATION[source]}, шаг ${bucketText(bucketMs)}`,
      value:
        facts.executionMs === null
          ? 'план без времени выполнения'
          : formatDuration(facts.executionMs),
      how: bench.db.how(explain),
      note: planNoteOf(facts),
    });
  }
  bench.observe(observationOf(measured));

  return {
    rows,
    note:
      `окно ${WINDOW_TEXT} до момента снятия по часам базы, прибор ${target.deviceCode}, ` +
      `метрики ${target.metricKeys.join(', ')}; запрос взят из loadSeries ` +
      '(packages/db/src/store/read.ts), значения вписаны в текст вместо параметров, ' +
      'а EXPLAIN (ANALYZE, BUFFERS) выполняет тот же SELECT и ничего в базе не меняет',
  };
};

export const query: Measure = {
  name: 'query',
  title: 'запрос серии под EXPLAIN ANALYZE: цена выбора источника',
  needs: ['db'],
  run,
};
