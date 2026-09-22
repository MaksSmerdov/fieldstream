import { numberOf, percentile } from './stats.js';
import type { Cells, LiveSample } from './measure.js';

/** Группы живого канала шлюза: у каждого экземпляра своя, пустая это след прежнего. */
const GATEWAY_GROUP_PREFIX = 'fs-api-';

/** Ячейка выборки текстом: отсутствующий столбец читается как пустое значение. */
const textOf = (cell: string | null | undefined): string | null => cell ?? null;

/** Линия стенда на момент замера: такт опроса и сколько строк даёт один её обход. */
export interface LinePlan {
  readonly lineCode: string;
  readonly pollIntervalMs: number;
  readonly devices: number;
  readonly metricsPerPoll: number;
}

/** Разбор выборки по линиям: строка без кода, такта или числа метрик в расчёт не идёт. */
export const linePlansOf = (rows: readonly Cells[]): LinePlan[] =>
  rows.flatMap((row) => {
    const lineCode = textOf(row['line_code']);
    const pollIntervalMs = numberOf(row['poll_interval_ms']);
    const devices = numberOf(row['devices']);
    const metricsPerPoll = numberOf(row['metrics_per_poll']);
    const known =
      lineCode !== null && pollIntervalMs !== null && devices !== null && metricsPerPoll !== null;

    return known && pollIntervalMs > 0
      ? [{ lineCode, pollIntervalMs, devices, metricsPerPoll }]
      : [];
  });

/**
 * Расчётный темп записи по топологии: каждая линия за такт кладёт в ts.readings по строке на
 * метрику каждого своего прибора. Цифра идеальная: она не знает ни об отказах опроса, ни о том,
 * что повторная доставка той же пачки строк не добавляет.
 */
export const expectedRate = (plans: readonly LinePlan[]): number | null =>
  plans.length === 0
    ? null
    : plans.reduce((sum, plan) => sum + (plan.metricsPerPoll * 1000) / plan.pollIntervalMs, 0);

/** Сколько приборов и строк за обход стоит за расчётом. */
export const planTotals = (
  plans: readonly LinePlan[],
): { readonly devices: number; readonly metricsPerPoll: number } => ({
  devices: plans.reduce((sum, plan) => sum + plan.devices, 0),
  metricsPerPoll: plans.reduce((sum, plan) => sum + plan.metricsPerPoll, 0),
});

/** Такты линий одной строкой: без них измеренный темп нечем истолковать. */
export const pollText = (plans: readonly LinePlan[]): string =>
  plans.length === 0
    ? 'включённых линий в топологии нет'
    : plans
        .map((plan) => `${plan.lineCode} ${plan.pollIntervalMs} мс (приборов: ${plan.devices})`)
        .join(', ');

/** Сколько обходов линии должно попасть в окно, чтобы темп перестал скакать между опросами. */
const ROUNDS_FOR_STEADY = 3;

/** Окно короче нескольких обходов: темп ложится на такт и скачет на целый обход в обе стороны. */
export const coarseWindow = (plans: readonly LinePlan[], windowMs: number): boolean =>
  plans.length > 0 &&
  windowMs < Math.max(...plans.map((plan) => plan.pollIntervalMs)) * ROUNDS_FOR_STEADY;

/** Темп записи за окно: пустое окно это null, а не ноль. */
export const rateOf = (rows: number, windowMs: number): number | null =>
  windowMs <= 0 || rows <= 0 ? null : (rows * 1000) / windowMs;

/** Задержки кадров в шкале шлюза: момент приёма минус метка времени кадра. */
export const delaysOf = (samples: readonly LiveSample[]): number[] =>
  samples.flatMap((sample) => {
    if (sample.frame.kind !== 'reading') return [];

    const at = Date.parse(sample.frame.data.ts);
    return Number.isFinite(at) ? [sample.atMs - at] : [];
  });

/** Приборы, попавшие в выборку событий: по ним видно, широкая выборка или с пары приборов. */
export const devicesOf = (samples: readonly LiveSample[]): number =>
  new Set(
    samples.flatMap((sample) =>
      sample.frame.kind === 'reading' ? [sample.frame.data.deviceCode] : [],
    ),
  ).size;

/** Разброс задержек по выборке. Пустая выборка это отсутствие цифр, а не нули. */
export interface DelayStats {
  readonly count: number;
  readonly devices: number;
  readonly min: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

/** Сводка по выборке событий reading. */
export const delayStats = (samples: readonly LiveSample[]): DelayStats => {
  const delays = delaysOf(samples);

  return {
    count: delays.length,
    devices: devicesOf(samples),
    min: percentile(delays, 0),
    p50: percentile(delays, 50),
    p95: percentile(delays, 95),
    p99: percentile(delays, 99),
    max: percentile(delays, 100),
  };
};

/** Конец лога партиции: нижняя и верхняя границы смещений. */
export interface PartitionEnd {
  readonly partition: number;
  readonly low: number;
  readonly high: number;
}

/** Подтверждённое смещение группы в партиции, как его отдаёт брокер. */
export interface CommittedPartition {
  readonly partition: number;
  readonly offset: string;
}

/**
 * Подтверждённое смещение из ответа брокера: '-1' означает, что коммита не было. Трактовка
 * та же, что у шлюза в services/api-gateway/src/pipeline/pipeline-calc.ts: расходиться нельзя,
 * иначе экран конвейера и замер будут называть разными словами одно и то же.
 */
export const committedOffset = (offset: string): number | null => {
  const value = Number(offset);
  return Number.isInteger(value) && value >= 0 ? value : null;
};

/** Пустая группа с префиксом шлюза это след прежнего экземпляра: в замер она не идёт. */
export const isStaleGatewayGroup = (groupId: string, state: string): boolean =>
  state === 'Empty' && groupId.startsWith(GATEWAY_GROUP_PREFIX);

/** Отставание группы в одной партиции. Без коммита отставания нет, а есть его отсутствие. */
export interface PartitionLag {
  readonly partition: number;
  readonly committed: number | null;
  readonly high: number;
  readonly lag: number | null;
}

/** Отставание по партициям топика: концы лога против подтверждённых смещений группы. */
export const partitionLags = (
  ends: readonly PartitionEnd[],
  committed: readonly CommittedPartition[],
): PartitionLag[] => {
  const offsets = new Map(
    committed.map((item) => [item.partition, committedOffset(item.offset)] as const),
  );

  return [...ends]
    .sort((left, right) => left.partition - right.partition)
    .map((end) => {
      const offset = offsets.get(end.partition) ?? null;

      return {
        partition: end.partition,
        committed: offset,
        high: end.high,
        lag: offset === null ? null : Math.max(0, end.high - offset),
      };
    });
};

/** Сумма отставания по партициям, где коммит был. */
export const totalLag = (rows: readonly PartitionLag[]): number =>
  rows.reduce((sum, row) => sum + (row.lag ?? 0), 0);

/** Группа читала топик, если хоть в одной его партиции есть коммит. */
export const hasCommits = (rows: readonly PartitionLag[]): boolean =>
  rows.some((row) => row.committed !== null);

/** Отставание по партициям строкой: 0: 0, 1: 3, 2: без коммита. */
export const lagText = (rows: readonly PartitionLag[]): string =>
  rows.length === 0
    ? 'партиций нет'
    : rows
        .map((row) => `${row.partition}: ${row.lag === null ? 'без коммита' : String(row.lag)}`)
        .join(', ');

/** Партиции без коммита: их отставание неизвестно, и в сумму они не попадают. */
export const uncommittedText = (rows: readonly PartitionLag[]): string | null => {
  const partitions = rows.flatMap((row) => (row.committed === null ? [row.partition] : []));

  return partitions.length === 0
    ? null
    : `коммита не было в партициях ${partitions.join(', ')}: их отставание в сумму не вошло`;
};
