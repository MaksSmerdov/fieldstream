import { literal } from '../db.js';
import { howRequest } from '../gateway.js';
import { formatDuration, formatNumber, formatPercent, formatRate, numberOf } from '../stats.js';
import type { Bench, Load, Measure, MeasureResult, Row } from '../measure.js';
import {
  coarseWindow,
  expectedRate,
  linePlansOf,
  planTotals,
  pollText,
  rateOf,
} from '../pipeline.js';
import type { LinePlan } from '../pipeline.js';

/**
 * Запас сверх окна: строки окна процессор дописывает пачками уже после его конца, и без
 * ожидания последние секунды окна считались бы пустыми.
 */
const SETTLE_MS = 3_000;

/**
 * Топология стенда на момент замера. core.lines и core.metric_defs засеяны из packages/device-profiles,
 * поэтому такты линий и число метрик профиля берутся оттуда же, откуда их берёт сборщик.
 */
const PLAN_SQL = `
  SELECT l.code AS line_code,
         l.poll_interval_ms::text AS poll_interval_ms,
         count(*)::text AS devices,
         sum(m.metrics)::text AS metrics_per_poll
  FROM core.devices d
  JOIN core.lines l ON l.id = d.line_id
  JOIN (SELECT profile_key, count(*) AS metrics FROM core.metric_defs GROUP BY profile_key) m
    ON m.profile_key = d.profile_key
  WHERE d.enabled AND l.enabled
  GROUP BY l.code, l.poll_interval_ms
  ORDER BY l.code
`;

/** Начало окна берётся у базы: окно считается по её часам, а не по часам хоста. */
const NOW_SQL = 'SELECT now()::text AS at';

/** Строки окна по меткам времени самих показаний. Границы в запросе те же, что и в замере. */
const countSql = (fromText: string, windowMs: number): string => `
  SELECT count(*)::text AS rows,
         count(DISTINCT device_id)::text AS devices,
         count(DISTINCT metric_key)::text AS metrics,
         min(ts)::text AS first_ts,
         max(ts)::text AS last_ts
  FROM ts.readings
  WHERE ts >= ${literal(fromText)}::timestamptz
    AND ts < ${literal(fromText)}::timestamptz + interval '${windowMs} milliseconds'
`;

/** Оговорка к числу строк: границы окна и что в них попало. */
const windowNote = (params: {
  readonly fromText: string;
  readonly windowMs: number;
  readonly devices: number | null;
  readonly metrics: number | null;
  readonly firstTs: string | null;
  readonly lastTs: string | null;
}): string => {
  const seen =
    params.devices === null || params.metrics === null
      ? 'приборов и метрик в окне нет'
      : `приборов ${params.devices}, метрик ${params.metrics}`;
  const edges =
    params.firstTs === null || params.lastTs === null
      ? 'ни одной строки с меткой из этого окна'
      : `первая строка ${params.firstTs}, последняя ${params.lastTs}`;

  return `окно от ${params.fromText} длиной ${formatDuration(params.windowMs)} по часам базы, ${seen}, ${edges}`;
};

/** Сравнение измеренного темпа с расчётным: без одной из цифр сравнивать нечего. */
const shareNote = (measured: number | null, expected: number | null): string | null =>
  measured === null || expected === null || expected <= 0
    ? null
    : `от расчётного темпа ${formatRate(expected, 'строк')} это ${formatPercent(measured / expected)}`;

/** Оговорка к темпу: доля от расчётного и предупреждение о слишком коротком окне. */
const rateNote = (parts: readonly (string | null)[]): string | null => {
  const said = parts.filter((part): part is string => part !== null);

  return said.length === 0 ? null : said.join('; ');
};

/** Строка с оговоркой, когда оговорка есть. */
const rowOf = (row: Row, note: string | null): Row => (note === null ? row : { ...row, note });

/**
 * Такты линий на момент замера. Команда line.set_poll_interval меняет такт только в памяти
 * сборщика: записи в core.lines за ней не идёт (они есть лишь в засеве топологии), и выборка
 * PLAN_SQL в нагрузочном режиме вернула бы прежний такт. Поэтому наведённый такт берётся
 * из самого нагрузочного режима и подставляется в расчёт вместо табличного.
 */
const livePlans = (plans: readonly LinePlan[], load: Load): LinePlan[] =>
  load.on && load.pollIntervalMs !== null
    ? plans.map((plan) => ({ ...plan, pollIntervalMs: load.pollIntervalMs ?? plan.pollIntervalMs }))
    : [...plans];

/** Откуда взят такт: команда живого состояния сборщика или та же выборка по топологии. */
const pollHow = (bench: Bench, planHow: string): string =>
  bench.load.on ? howRequest(bench.config.baseUrl, 'GET', '/api/lab/lines') : planHow;

/** Оговорка к такту: чем он наведён и почему в core.lines стоит другое значение. */
const pollNote = (bench: Bench): string | null =>
  bench.load.on
    ? 'такт наведён нагрузочным режимом командой line.set_poll_interval и действует только ' +
      'в памяти сборщика: в core.lines остаётся засеянный такт, его печатает выборка ' +
      'из строки «Расчётный темп по топологии»; прежние такты возвращаются после замеров'
    : null;

/**
 * Темп записи в ts.readings. Измеренное число снимается по окну, которое замер выжидает сам,
 * поэтому в нагрузочном режиме в окно попадает уже новый такт, а не остатки прежнего. Рядом
 * стоит расчётное число по топологии и такты линий: без них измеренное истолковать нечем.
 */
const run = async (bench: Bench): Promise<MeasureResult> => {
  const { windowMs } = bench.config;
  const plans = livePlans(linePlansOf(await bench.db.rows(PLAN_SQL)), bench.load);
  const expected = expectedRate(plans);
  const totals = planTotals(plans);
  const planHow = bench.db.how(PLAN_SQL);
  const [started] = await bench.db.rows(NOW_SQL);
  const fromText = started?.['at'] ?? null;
  if (fromText === null)
    throw new Error('база не назвала своё время: окно замера не от чего вести');

  bench.note(`окно ${formatDuration(windowMs)} от ${fromText} по часам базы, ждём его целиком`);
  await bench.sleep(windowMs + SETTLE_MS);

  const sql = countSql(fromText, windowMs);
  const [counted] = await bench.db.rows(sql);
  const rows = numberOf(counted?.['rows']) ?? 0;
  const rate = rateOf(rows, windowMs);
  if (rate === null) {
    bench.observe(
      'за окно в ts.readings не легло ни одной строки: конвейер стоит или данные идут не сюда',
    );
  }

  return {
    rows: [
      rowOf(
        {
          label: 'Записано строк за окно',
          value: `${formatNumber(rows)} строк за ${formatDuration(windowMs)}`,
          how: bench.db.how(sql),
        },
        windowNote({
          fromText,
          windowMs,
          devices: numberOf(counted?.['devices']),
          metrics: numberOf(counted?.['metrics']),
          firstTs: counted?.['first_ts'] ?? null,
          lastTs: counted?.['last_ts'] ?? null,
        }),
      ),
      rowOf(
        {
          label: 'Темп записи',
          value: rate === null ? 'строк за окно нет' : formatRate(rate, 'строк'),
          how: bench.db.how(sql),
        },
        rateNote([
          shareNote(rate, expected),
          coarseWindow(plans, windowMs)
            ? 'окно короче трёх обходов линии, поэтому цифра скачет на целый обход в обе стороны: ' +
              'для устойчивого темпа окно задаётся переменной BENCH_WINDOW_MS с запасом на такт'
            : null,
        ]),
      ),
      rowOf(
        {
          label: 'Расчётный темп по топологии',
          value: expected === null ? 'включённых линий нет' : formatRate(expected, 'строк'),
          how: planHow,
        },
        expected === null
          ? null
          : `приборов ${totals.devices}, строк за один обход всех линий ${totals.metricsPerPoll}; ` +
              'расчёт не знает ни об отказах опроса, ни о том, что повторная доставка пачки строк не добавляет' +
              (bench.load.on
                ? `; такт в расчёте взят действующий, а не табличный: ${pollHow(bench, planHow)}`
                : ''),
      ),
      rowOf(
        {
          label: 'Такт опроса линий на момент замера',
          value: pollText(plans),
          how: pollHow(bench, planHow),
        },
        pollNote(bench),
      ),
    ],
    note:
      'Темп снят по меткам времени самих показаний в окне, которое замер выждал целиком, ' +
      `с запасом ${formatDuration(SETTLE_MS)} на дозапись пачек. Повторная доставка той же пачки ` +
      'строк не добавляет: вставка идёт с ON CONFLICT DO NOTHING.',
  };
};

export const throughput: Measure = {
  name: 'throughput',
  title: 'темп записи показаний в ts.readings',
  needs: ['db'],
  run,
};
