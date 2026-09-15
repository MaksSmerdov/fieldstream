import type { SeekEntry } from 'kafkajs';

/** Смещения окна одной партиции: от start включительно до end исключительно. */
export interface PartitionWindow {
  readonly partition: number;
  readonly start: bigint;
  readonly end: bigint;
}

/** Границы лога партиции: первое живое смещение и конец. */
export interface PartitionBounds {
  readonly partition: number;
  readonly low: string;
  readonly high: string;
}

/** Смещения по времени начала и конца окна и границы лога по партициям. */
export interface OffsetsByTime {
  readonly starts: readonly SeekEntry[];
  readonly ends: readonly SeekEntry[];
  readonly bounds: readonly PartitionBounds[];
}

const clamp = (value: bigint, min: bigint, max: bigint): bigint =>
  value < min ? min : value > max ? max : value;

/** Смещение по времени, если брокер его не нашёл или вернул -1, это конец лога. */
const offsetOf = (entries: readonly SeekEntry[], partition: number, high: bigint): bigint => {
  const entry = entries.find((item) => item.partition === partition);
  if (entry === undefined) return high;
  const offset = BigInt(entry.offset);
  return offset < 0n ? high : offset;
};

/**
 * Окно по партициям. Смещение по времени это первое сообщение не раньше заданного момента, а без
 * такого конец лога. Начало не раньше первого живого смещения: удалённое по сроку хранения
 * не прочитать, и ждать его до предела времени незачем.
 */
export const planPartitions = (offsets: OffsetsByTime): PartitionWindow[] =>
  offsets.bounds
    .map((bounds) => {
      const low = BigInt(bounds.low);
      const high = BigInt(bounds.high);
      const start = clamp(offsetOf(offsets.starts, bounds.partition, high), low, high);
      const end = clamp(offsetOf(offsets.ends, bounds.partition, high), start, high);
      return { partition: bounds.partition, start, end };
    })
    .sort((left, right) => left.partition - right.partition);

/** Позиция, с которой партиция читается после вступления в группу. */
export interface SeekPosition {
  readonly partition: number;
  readonly offset: string;
}

/** Ход чтения окна по партициям. */
export interface PartitionTracker {
  readonly offsetsTotal: number;
  readonly accepts: (partition: number, offset: string) => boolean;
  readonly skipLost: (partition: number, offset: string) => number;
  readonly advance: (partition: number, offset: string) => void;
  readonly isDone: (partition: number) => boolean;
  readonly allDone: () => boolean;
  readonly pending: () => SeekPosition[];
  readonly finished: () => number[];
  readonly offsetsDone: () => number;
}

/**
 * Ход чтения окна. Сообщение нужно, только если оно внутри окна и дальше уже обработанного:
 * живые кадры до применения seek лежат за концом окна и партицию готовой не делают, а повтор
 * после ребаланса не считается дважды. Партиция готова, когда обработано смещение end - 1.
 * Сообщение дальше позиции недочитанной партиции значит, что смещения между ними удалены по сроку
 * хранения: сырой топик без уплотнения и транзакций, других дыр в смещениях у него нет. skipLost
 * переносит позицию на такое сообщение, но не дальше конца окна, и возвращает число потерянных
 * смещений окна: иначе партиция не закроется, а брокер будет отдавать одну и ту же пачку.
 */
export const createPartitionTracker = (windows: readonly PartitionWindow[]): PartitionTracker => {
  const byPartition = new Map(windows.map((window) => [window.partition, window]));
  const next = new Map(windows.map((window) => [window.partition, window.start]));
  const total = windows.reduce((sum, window) => sum + (window.end - window.start), 0n);

  const isDone = (partition: number): boolean => {
    const window = byPartition.get(partition);
    const position = next.get(partition);
    return window === undefined || position === undefined || position >= window.end;
  };

  return {
    offsetsTotal: Number(total),
    accepts: (partition, offset) => {
      const window = byPartition.get(partition);
      const position = next.get(partition);
      if (window === undefined || position === undefined) return false;
      const value = BigInt(offset);
      return value >= position && value < window.end;
    },
    skipLost: (partition, offset) => {
      const window = byPartition.get(partition);
      const position = next.get(partition);
      if (window === undefined || position === undefined || position >= window.end) return 0;
      const value = BigInt(offset);
      if (value <= position) return 0;
      const target = value < window.end ? value : window.end;
      next.set(partition, target);
      return Number(target - position);
    },
    advance: (partition, offset) => {
      const position = next.get(partition);
      const following = BigInt(offset) + 1n;
      if (position !== undefined && following > position) next.set(partition, following);
    },
    isDone,
    allDone: () => windows.every((window) => isDone(window.partition)),
    pending: () =>
      windows
        .filter((window) => !isDone(window.partition))
        .map((window) => ({
          partition: window.partition,
          offset: (next.get(window.partition) ?? window.start).toString(),
        })),
    finished: () => windows.filter((window) => isDone(window.partition)).map((w) => w.partition),
    offsetsDone: () =>
      Number(
        windows.reduce((sum, window) => {
          const position = next.get(window.partition) ?? window.start;
          return sum + ((position < window.end ? position : window.end) - window.start);
        }, 0n),
      ),
  };
};
