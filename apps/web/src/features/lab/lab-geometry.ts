import type { LatencyWindow, LineStatus, ReconnectStep } from '@fieldstream/contracts';

export type BreakerSnapshot = LineStatus['devices'][number]['breaker'];

export interface PlotBox {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

const clampShare = (value: number): number => Math.min(1, Math.max(0, value));

const plotWidth = (box: PlotBox): number => box.width - box.left - box.right;

const plotHeight = (box: PlotBox): number => box.height - box.top - box.bottom;

export const STALE_SNAPSHOT_MS = 30_000;

/** Снимок линии старше порога по серверным часам. */
export const isSnapshotStale = (
  ts: string,
  nowMs: number,
  limitMs: number = STALE_SNAPSHOT_MS,
): boolean => {
  const atMs = Date.parse(ts);

  return Number.isNaN(atMs) || nowMs - atMs > limitMs;
};

export interface ProbeCountdown {
  readonly remainingMs: number;
  readonly fraction: number;
  readonly waiting: boolean;
}

/** Отсчёт до пробы размыкателя: остаток, доля от паузы и признак «ждёт пробы». */
export const probeCountdown = (breaker: BreakerSnapshot, nowMs: number): ProbeCountdown | null => {
  if (breaker.state === 'closed' || breaker.nextProbeAt === null) return null;

  const atMs = Date.parse(breaker.nextProbeAt);
  if (Number.isNaN(atMs)) return null;

  const remainingMs = Math.max(0, atMs - nowMs);
  const fraction = breaker.probeDelayMs > 0 ? clampShare(remainingMs / breaker.probeDelayMs) : 0;

  return { remainingMs, fraction, waiting: breaker.state === 'open' && remainingMs === 0 };
};

export const RING_RADIUS = 16;

/** Штрих кольца отсчёта: длина окружности и сдвиг под оставшуюся долю. */
export const ringDash = (
  fraction: number,
  radius: number = RING_RADIUS,
): { readonly circumference: number; readonly offset: number } => {
  const circumference = 2 * Math.PI * radius;

  return { circumference, offset: circumference * (1 - clampShare(fraction)) };
};

export const LADDER = Object.freeze({
  baseMs: 1_000,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.1,
  steps: 6,
});

export const LADDER_BOX: PlotBox = {
  width: 360,
  height: 200,
  left: 44,
  right: 10,
  top: 12,
  bottom: 30,
};

const LADDER_MIN_MS = 800;
const LADDER_MAX_MS = 36_000;
const DOT_GAP = 8;

/** Базовая задержка ступени по номеру попытки. */
export const ladderBaseMs = (attempt: number): number =>
  Math.min(LADDER.baseMs * LADDER.factor ** Math.max(0, attempt), LADDER.maxMs);

/** Столбец лестницы по номеру попытки: после пятой потолок. */
export const ladderColumn = (attempt: number): number =>
  Math.min(Math.max(0, attempt), LADDER.steps - 1);

/** Высота задержки на лестнице по логарифмической шкале. */
export const ladderY = (ms: number, box: PlotBox = LADDER_BOX): number => {
  const clamped = Math.min(Math.max(ms, LADDER_MIN_MS), LADDER_MAX_MS);
  const share = Math.log(clamped / LADDER_MIN_MS) / Math.log(LADDER_MAX_MS / LADDER_MIN_MS);

  return box.top + plotHeight(box) * (1 - share);
};

export interface LadderStep {
  readonly attempt: number;
  readonly baseMs: number;
  readonly lowMs: number;
  readonly highMs: number;
  readonly x: number;
  readonly width: number;
  readonly treadY: number;
  readonly bandY: number;
  readonly bandHeight: number;
}

/** Ступени лестницы переподключения с полосами разброса. */
export const ladderSteps = (box: PlotBox = LADDER_BOX): LadderStep[] => {
  const slot = plotWidth(box) / LADDER.steps;

  return Array.from({ length: LADDER.steps }, (_, attempt) => {
    const baseMs = ladderBaseMs(attempt);
    const lowMs = Math.round(baseMs * (1 - LADDER.jitter));
    const highMs = Math.round(baseMs * (1 + LADDER.jitter));
    const bandY = ladderY(highMs, box);

    return {
      attempt,
      baseMs,
      lowMs,
      highMs,
      x: box.left + slot * attempt,
      width: slot,
      treadY: ladderY(baseMs, box),
      bandY,
      bandHeight: ladderY(lowMs, box) - bandY,
    };
  });
};

export interface ReconnectDot {
  readonly key: string;
  readonly attempt: number;
  readonly column: number;
  readonly chosenMs: number;
  readonly baseMs: number;
  readonly jitterMs: number;
  readonly x: number;
  readonly y: number;
}

/** Точки фактических задержек: по столбцу попытки, несколько в столбце раздвинуты. */
export const reconnectDots = (
  steps: readonly ReconnectStep[],
  box: PlotBox = LADDER_BOX,
): ReconnectDot[] => {
  const slot = plotWidth(box) / LADDER.steps;
  const totals = new Map<number, number>();
  for (const step of steps) {
    const column = ladderColumn(step.attempt);
    totals.set(column, (totals.get(column) ?? 0) + 1);
  }

  const seen = new Map<number, number>();

  return steps.map((step, index) => {
    const column = ladderColumn(step.attempt);
    const total = totals.get(column) ?? 1;
    const order = seen.get(column) ?? 0;
    seen.set(column, order + 1);
    const spread = total > 1 ? Math.min(DOT_GAP, (slot - 12) / (total - 1)) : 0;

    return {
      key: `${step.at}:${index}`,
      attempt: step.attempt,
      column,
      chosenMs: step.chosenMs,
      baseMs: step.baseMs,
      jitterMs: step.jitterMs,
      x: box.left + slot * (column + 0.5) + (order - (total - 1) / 2) * spread,
      y: ladderY(step.chosenMs, box),
    };
  });
};

export const WATCHDOG_WARNING = 0.8;
export const WATCHDOG_DANGER = 0.95;

export type Tone = 'normal' | 'warning' | 'danger';

/** Цвет полосы по доле от предела. */
export const toneOf = (ratio: number): Tone => {
  if (ratio >= WATCHDOG_DANGER) return 'danger';
  if (ratio >= WATCHDOG_WARNING) return 'warning';

  return 'normal';
};

export type WatchdogTone = Tone | 'offline';

export type CycleOutcome = NonNullable<LineStatus['lastCycle']>['outcome'];

export type WatchdogView =
  | {
      readonly mode: 'cycle';
      readonly elapsedMs: number;
      readonly limitMs: number;
      readonly fraction: number;
      readonly tone: Tone;
      readonly frozen: boolean;
    }
  | {
      readonly mode: 'last';
      readonly elapsedMs: number;
      readonly limitMs: number;
      readonly fraction: number;
      readonly tone: WatchdogTone;
      readonly outcome: CycleOutcome;
    }
  | { readonly mode: 'none' };

const shareOf = (
  elapsedMs: number,
  limitMs: number,
): { elapsedMs: number; limitMs: number; fraction: number; tone: Tone } => {
  const ratio = limitMs > 0 ? elapsedMs / limitMs : elapsedMs > 0 ? 1 : 0;

  return { elapsedMs, limitMs, fraction: clampShare(ratio), tone: toneOf(ratio) };
};

/** Цвет последнего обхода: прерванный сторожем опасен, оборванный портом отдельно. */
const lastTone = (outcome: CycleOutcome, tone: Tone): WatchdogTone => {
  if (outcome === 'watchdog') return 'danger';
  if (outcome === 'disconnected') return 'offline';

  return tone;
};

/** Полоса сторожа: идущий обход против предела (на старом снимке замирает) или последний против такта. */
export const watchdogView = (
  line: Pick<LineStatus, 'ts' | 'watchdog' | 'lastCycle' | 'pollIntervalMs'>,
  nowMs: number,
  stale = false,
): WatchdogView => {
  const startedAt = line.watchdog.cycleStartedAt;
  if (startedAt !== null) {
    const startedMs = Date.parse(startedAt);
    const endMs = stale ? Date.parse(line.ts) : nowMs;
    const elapsedMs =
      Number.isNaN(startedMs) || Number.isNaN(endMs) ? 0 : Math.max(0, endMs - startedMs);

    return { mode: 'cycle', ...shareOf(elapsedMs, line.watchdog.limitMs), frozen: stale };
  }

  if (line.lastCycle === null) return { mode: 'none' };

  const { outcome } = line.lastCycle;
  const share = shareOf(line.lastCycle.durationMs, line.pollIntervalMs);

  return { mode: 'last', ...share, tone: lastTone(outcome, share.tone), outcome };
};

export const MIN_SAMPLES_FOR_HINT = 100;

/** Сколько замеров не хватает до рекомендации таймаута. */
export const samplesMissing = (samples: number): number =>
  Math.max(0, MIN_SAMPLES_FOR_HINT - samples);

export const HISTOGRAM_BOX: PlotBox = {
  width: 560,
  height: 230,
  left: 40,
  right: 16,
  top: 50,
  bottom: 30,
};

const BAR_GAP = 4;
const MIN_BAR_HEIGHT = 2;
const LABEL_ROWS = 3;
const LABEL_GAP = 44;
const LABEL_ROW_HEIGHT = 13;
const LABEL_FIRST_Y = 12;

export interface HistogramBar {
  readonly index: number;
  readonly fromMs: number;
  readonly toMs: number | null;
  readonly count: number;
  readonly x: number;
  readonly width: number;
  readonly y: number;
  readonly height: number;
}

/** Столбцы гистограммы: равные ячейки по корзинам, высота по доле от самой полной. */
export const histogramBars = (
  latency: Pick<LatencyWindow, 'bucketsMs' | 'counts'>,
  box: PlotBox = HISTOGRAM_BOX,
): HistogramBar[] => {
  const slot = plotWidth(box) / (latency.bucketsMs.length + 1);
  const max = Math.max(0, ...latency.counts);
  const baseline = box.height - box.bottom;

  return latency.counts.map((count, index) => {
    const raw = max === 0 ? 0 : (count / max) * plotHeight(box);
    const height = count === 0 ? 0 : Math.max(MIN_BAR_HEIGHT, raw);

    return {
      index,
      fromMs: index === 0 ? 0 : (latency.bucketsMs[index - 1] ?? 0),
      toMs: latency.bucketsMs[index] ?? null,
      count,
      x: box.left + slot * index + BAR_GAP / 2,
      width: Math.max(1, slot - BAR_GAP),
      y: baseline - height,
      height,
    };
  });
};

/** Положение времени на оси гистограммы; за двойной последней границей упирается в край. */
export const latencyX = (
  ms: number,
  bucketsMs: readonly number[],
  box: PlotBox = HISTOGRAM_BOX,
): { readonly x: number; readonly clamped: boolean } => {
  const slots = bucketsMs.length + 1;
  const slot = plotWidth(box) / slots;
  const index = bucketsMs.findIndex((bound) => ms <= bound);

  if (index === -1) {
    const last = bucketsMs[bucketsMs.length - 1] ?? 0;
    const share = last > 0 ? clampShare((ms - last) / last) : 1;

    return { x: box.left + slot * (slots - 1 + share), clamped: ms > last * 2 };
  }

  const lower = index === 0 ? 0 : (bucketsMs[index - 1] ?? 0);
  const upper = bucketsMs[index] ?? lower;
  const share = upper > lower ? clampShare((ms - lower) / (upper - lower)) : 1;

  return { x: box.left + slot * (index + share), clamped: false };
};

export type MarkerKind = 'p50' | 'p95' | 'p99' | 'suggested' | 'timeout';

export interface HistogramMarker {
  readonly kind: MarkerKind;
  readonly ms: number;
  readonly x: number;
  readonly clamped: boolean;
  readonly row: number;
  readonly labelX: number;
  readonly labelY: number;
}

/** Строка подписи метки: первая, где подпись не наезжает на соседнюю. */
const pickRow = (rowEnds: readonly (number | undefined)[], x: number): number => {
  let best = 0;
  let bestGap = -Infinity;
  for (let row = 0; row < LABEL_ROWS; row += 1) {
    const end = rowEnds[row];
    if (end === undefined || x - end >= LABEL_GAP) return row;
    if (x - end > bestGap) {
      best = row;
      bestGap = x - end;
    }
  }

  return best;
};

/** Вертикальные метки перцентилей и таймаутов с разнесёнными по строкам подписями. */
export const histogramMarkers = (
  latency: LatencyWindow,
  requestTimeoutMs: number,
  box: PlotBox = HISTOGRAM_BOX,
): HistogramMarker[] => {
  const candidates: readonly (readonly [MarkerKind, number | null])[] = [
    ['p50', latency.p50Ms],
    ['p95', latency.p95Ms],
    ['p99', latency.p99Ms],
    ['suggested', latency.suggestedTimeoutMs],
    ['timeout', requestTimeoutMs],
  ];

  const placed = candidates
    .flatMap(([kind, ms]) =>
      ms === null ? [] : [{ kind, ms, ...latencyX(ms, latency.bucketsMs, box) }],
    )
    .sort((left, right) => left.x - right.x);

  const rowEnds: (number | undefined)[] = [];
  const minLabelX = box.left + LABEL_GAP / 2;
  const maxLabelX = box.width - box.right - LABEL_GAP / 2;

  return placed.map((marker) => {
    const row = pickRow(rowEnds, marker.x);
    rowEnds[row] = marker.x;

    return {
      ...marker,
      row,
      labelX: Math.min(maxLabelX, Math.max(minLabelX, marker.x)),
      labelY: LABEL_FIRST_Y + row * LABEL_ROW_HEIGHT,
    };
  });
};
