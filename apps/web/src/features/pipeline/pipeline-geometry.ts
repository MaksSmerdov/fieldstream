import type { PipelineMember, PipelinePartition } from '@fieldstream/contracts';

/** Доля в процентах, зажатая в пределы полосы. */
const clampPct = (value: number): number => Math.min(100, Math.max(0, value));

/** Округление координаты до сотых: длинные дроби в разметке ничего не добавляют. */
const round = (value: number): number => Math.round(value * 100) / 100;

/** Где подтверждённое смещение относительно лога партиции. */
export type CommitPlace = 'none' | 'inside' | 'before-log' | 'after-log';

export interface PartitionBarShape {
  readonly emptyLog: boolean;
  readonly commitPct: number | null;
  readonly lagFromPct: number;
  readonly lagWidthPct: number;
  readonly place: CommitPlace;
}

/** Полоса партиции: отметка коммита и отрезок отставания в долях лога от low до high. */
export const partitionBarShape = (
  low: number,
  high: number,
  committed: number | null,
): PartitionBarShape => {
  const span = high - low;

  if (committed === null) {
    return { emptyLog: span <= 0, commitPct: null, lagFromPct: 100, lagWidthPct: 0, place: 'none' };
  }

  const place: CommitPlace =
    committed < low ? 'before-log' : committed > high ? 'after-log' : 'inside';

  if (span <= 0) {
    return {
      emptyLog: true,
      commitPct: committed < low ? 0 : 100,
      lagFromPct: 100,
      lagWidthPct: 0,
      place,
    };
  }

  const commitPct = clampPct(((committed - low) / span) * 100);

  return { emptyLog: false, commitPct, lagFromPct: commitPct, lagWidthPct: 100 - commitPct, place };
};

/** Сколько сообщений лежит в логе топика: сумма high - low по партициям. */
export const logMessages = (partitions: readonly PipelinePartition[]): number =>
  partitions.reduce((sum, item) => sum + Math.max(0, item.high - item.low), 0);

export const MEMBER_TONES = 6;

/** Номер цвета участника по порядку в группе. */
export const memberTones = (members: readonly PipelineMember[]): ReadonlyMap<string, number> =>
  new Map(members.map((member, index) => [member.memberId, index % MEMBER_TONES]));

export const SNAPSHOT_STALE_MS = 10_000;

/** Снимок брокера устарел: шлюз давно не получал ответа. */
export const isSnapshotStale = (ageMs: number | null): boolean =>
  ageMs !== null && ageMs > SNAPSHOT_STALE_MS;

export const LAG_WINDOW_MS = 300_000;
export const LAG_MAX_POINTS = 150;

export interface LagPoint {
  readonly atMs: number;
  readonly lag: number;
}

export interface LagHistory {
  readonly lastAtMs: number | null;
  readonly series: ReadonlyMap<string, readonly LagPoint[]>;
}

export interface LagSample {
  readonly sampledAt: string;
  readonly groups: readonly { readonly groupId: string; readonly totalLag: number }[];
}

export interface LagLimits {
  readonly windowMs: number;
  readonly maxPoints: number;
}

export const EMPTY_LAG_HISTORY: LagHistory = { lastAtMs: null, series: new Map() };

/** Добавление снимка в историю отставания: без дублей, в пределах окна и числа точек. */
export const appendLagSample = (
  history: LagHistory,
  sample: LagSample,
  limits: LagLimits = { windowMs: LAG_WINDOW_MS, maxPoints: LAG_MAX_POINTS },
): LagHistory => {
  const atMs = Date.parse(sample.sampledAt);
  if (Number.isNaN(atMs)) return history;
  if (history.lastAtMs !== null && atMs <= history.lastAtMs) return history;

  const fromMs = atMs - limits.windowMs;
  const lags = new Map(sample.groups.map((group) => [group.groupId, group.totalLag]));
  const series = new Map<string, readonly LagPoint[]>();

  for (const groupId of new Set([...history.series.keys(), ...lags.keys()])) {
    const lag = lags.get(groupId);
    const points = [
      ...(history.series.get(groupId) ?? []),
      ...(lag === undefined ? [] : [{ atMs, lag }]),
    ]
      .filter((point) => point.atMs >= fromMs)
      .slice(-Math.max(1, limits.maxPoints));

    if (points.length > 0) series.set(groupId, points);
  }

  return { lastAtMs: atMs, series };
};

export type LagTrend = 'growing' | 'shrinking' | 'steady' | 'unknown';

export const TREND_POINTS = 3;

/** Направление отставания по последним точкам: рост засчитывается без единого спада. */
export const lagTrend = (points: readonly LagPoint[], span: number = TREND_POINTS): LagTrend => {
  if (points.length < Math.max(2, span)) return 'unknown';

  const tail = points.slice(-Math.max(2, span)).map((point) => point.lag);
  let rising = true;
  let falling = true;

  for (let index = 1; index < tail.length; index += 1) {
    const before = tail[index - 1] ?? 0;
    const after = tail[index] ?? 0;
    if (after < before) rising = false;
    if (after > before) falling = false;
  }

  const first = tail[0] ?? 0;
  const last = tail[tail.length - 1] ?? 0;
  if (rising && last > first) return 'growing';
  if (falling && last < first) return 'shrinking';

  return 'steady';
};

export interface Sparkline {
  readonly path: string;
  readonly maxLag: number;
}

/** Линия истории в координатах рамки: время по горизонтали, отставание от нуля до максимума. */
export const sparkline = (
  points: readonly LagPoint[],
  width: number,
  height: number,
  pad = 4,
): Sparkline => {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return { path: '', maxLag: 0 };

  const maxLag = Math.max(...points.map((point) => point.lag));
  const scale = Math.max(1, maxLag);
  const inner = height - pad * 2;
  const yOf = (lag: number): number => round(pad + inner - (lag / scale) * inner);

  if (points.length === 1) {
    return { path: `M0 ${yOf(first.lag)} H${width}`, maxLag };
  }

  const spanMs = last.atMs - first.atMs;
  const path = points
    .map((point, index) => {
      const x = spanMs <= 0 ? width : round(((point.atMs - first.atMs) / spanMs) * width);

      return `${index === 0 ? 'M' : 'L'}${x} ${yOf(point.lag)}`;
    })
    .join(' ');

  return { path, maxLag };
};

export interface MapBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type MapNodeId =
  'sim' | 'collector' | 'raw' | 'cycles' | 'status' | 'processor' | 'db' | 'gateway' | 'browser';

export const MAP_VIEWBOX = { width: 1370, height: 320 } as const;

export const MAP_NODES: Readonly<Record<MapNodeId, MapBox>> = {
  sim: { x: 16, y: 132, width: 124, height: 56 },
  collector: { x: 176, y: 132, width: 124, height: 56 },
  raw: { x: 430, y: 24, width: 180, height: 56 },
  cycles: { x: 430, y: 132, width: 180, height: 56 },
  status: { x: 430, y: 240, width: 180, height: 56 },
  processor: { x: 690, y: 64, width: 160, height: 72 },
  db: { x: 930, y: 64, width: 170, height: 72 },
  gateway: { x: 930, y: 232, width: 170, height: 72 },
  browser: { x: 1180, y: 232, width: 170, height: 72 },
};

export interface EdgeShape {
  readonly path: string;
  readonly arrow: string;
  readonly labelX: number;
  readonly labelY: number;
}

/** Связь двух узлов ломаной: вправо в левый край цели или вниз в её верхний край. */
export const edgeShape = (from: MapBox, to: MapBox): EdgeShape => {
  if (to.x >= from.x + from.width) {
    const x1 = from.x + from.width;
    const y1 = from.y + from.height / 2;
    const x2 = to.x;
    const y2 = to.y + to.height / 2;
    const midX = round(x1 + (x2 - x1) / 2);
    const straight = y1 === y2;

    return {
      path: straight ? `M${x1} ${y1} H${x2}` : `M${x1} ${y1} H${midX} V${y2} H${x2}`,
      arrow: `${x2},${y2} ${x2 - 8},${y2 - 4} ${x2 - 8},${y2 + 4}`,
      labelX: round(straight ? midX : (midX + x2) / 2),
      labelY: y2 - 8,
    };
  }

  const x1 = from.x + from.width / 2;
  const y1 = from.y + from.height;
  const x2 = to.x + to.width / 2;
  const y2 = to.y;
  const midY = round(y1 + (y2 - y1) / 2);

  return {
    path: x1 === x2 ? `M${x1} ${y1} V${y2}` : `M${x1} ${y1} V${midY} H${x2} V${y2}`,
    arrow: `${x2},${y2} ${x2 - 4},${y2 - 8} ${x2 + 4},${y2 - 8}`,
    labelX: x2 + 8,
    labelY: midY,
  };
};
