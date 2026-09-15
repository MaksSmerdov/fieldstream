import type { PipelineLag, PipelineMember, PipelineRebalance } from '@fieldstream/contracts';

export interface PartitionEnd {
  readonly partition: number;
  readonly low: number;
  readonly high: number;
}

export interface CommittedTopic {
  readonly topic: string;
  readonly partitions: readonly { readonly partition: number; readonly offset: string }[];
}

export interface Reading {
  readonly value: number;
  readonly atMs: number;
}

export const REBALANCE_LIMIT = 50;

const GATEWAY_GROUP_PREFIX = 'fs-api-';

const byText = (left: string, right: string): number => left.localeCompare(right);

const keyOf = (topic: string, partition: number): string => `${topic}#${partition}`;

/** Подтверждённое смещение из ответа брокера: '-1' означает, что коммита не было. */
export const committedOffset = (offset: string): number | null => {
  const value = Number(offset);
  return Number.isInteger(value) && value >= 0 ? value : null;
};

/** Отставание группы по партициям. Топики группы это назначенные плюс те, где есть коммит. */
export const groupLag = (
  ends: ReadonlyMap<string, readonly PartitionEnd[]>,
  committed: readonly CommittedTopic[],
  members: readonly PipelineMember[],
): PipelineLag[] => {
  const owners = new Map<string, string>();
  for (const member of members) {
    for (const assignment of member.assignments) {
      for (const partition of assignment.partitions) {
        owners.set(keyOf(assignment.topic, partition), member.memberId);
      }
    }
  }

  const offsets = new Map<string, number>();
  for (const topic of committed) {
    for (const item of topic.partitions) {
      const offset = committedOffset(item.offset);
      if (offset !== null) offsets.set(keyOf(topic.topic, item.partition), offset);
    }
  }

  const topics = new Set([
    ...members.flatMap((member) => member.assignments.map((assignment) => assignment.topic)),
    ...committed
      .filter((topic) => topic.partitions.some((item) => committedOffset(item.offset) !== null))
      .map((topic) => topic.topic),
  ]);

  return [...topics].sort(byText).flatMap((topic) =>
    [...(ends.get(topic) ?? [])]
      .sort((left, right) => left.partition - right.partition)
      .map((end) => {
        const key = keyOf(topic, end.partition);
        const offset = offsets.get(key) ?? null;

        return {
          topic,
          partition: end.partition,
          committed: offset,
          high: end.high,
          lag: offset === null ? null : Math.max(0, end.high - offset),
          memberId: owners.get(key) ?? null,
        };
      }),
  );
};

/** Сумма отставания по партициям, где коммит был. */
export const totalLag = (rows: readonly PipelineLag[]): number =>
  rows.reduce((sum, row) => sum + (row.lag ?? 0), 0);

/** Темп в секунду по приросту счётчика между двумя замерами. На первом замере темпа нет. */
export const ratePerSec = (previous: Reading | null, current: Reading): number | null => {
  if (previous === null) return null;

  const seconds = (current.atMs - previous.atMs) / 1000;
  if (seconds <= 0) return null;

  return Math.max(0, current.value - previous.value) / seconds;
};

/** Оценка секунд на разбор отставания: null, если темп топиков неизвестен или нулевой. */
export const lagSeconds = (total: number, rates: readonly (number | null)[]): number | null => {
  if (rates.length === 0) return null;

  let sum = 0;
  for (const rate of rates) {
    if (rate === null) return null;
    sum += rate;
  }

  return sum > 0 ? total / sum : null;
};

/** Пустая группа с префиксом шлюза это след прежнего экземпляра: в снимок она не попадает. */
export const isStaleGatewayGroup = (groupId: string, state: string): boolean =>
  state === 'Empty' && groupId.startsWith(GATEWAY_GROUP_PREFIX);

/** Отпечаток состава и раскладки группы, не зависящий от порядка участников и партиций. */
const shapeOf = (members: readonly PipelineMember[]): string =>
  members
    .map((member) => {
      const assignments = member.assignments
        .map(
          (assignment) =>
            `${assignment.topic}:${[...assignment.partitions].sort((a, b) => a - b).join(',')}`,
        )
        .sort(byText);
      return `${member.memberId}=${assignments.join(';')}`;
    })
    .sort(byText)
    .join('|');

/** Группа посреди ребаланса: брокер ещё не отдаёт раскладку участников. */
export const isRebalancing = (state: string): boolean =>
  state === 'PreparingRebalance' || state === 'CompletingRebalance';

/**
 * Устоявшийся состав групп между опросами. null означает, что группа была видна
 * на первом опросе посреди ребаланса и её устоявшегося состава ещё не было.
 */
export type SettledShapes = ReadonlyMap<string, readonly PipelineMember[] | null>;

export interface ObservedGroup {
  readonly state: string;
  readonly members: readonly PipelineMember[];
}

export interface RebalanceTracking {
  readonly settled: SettledShapes;
  readonly rebalances: PipelineRebalance[];
}

/**
 * Ребалансы между опросами: сменился состав, раскладка или группа исчезла.
 * Сравниваются только устоявшиеся снимки, группа посреди ребаланса хранит прежний.
 */
export const trackRebalances = (
  previous: SettledShapes | null,
  current: ReadonlyMap<string, ObservedGroup>,
  at: string,
): RebalanceTracking => {
  const settled = new Map<string, readonly PipelineMember[] | null>();
  const rebalances: PipelineRebalance[] = [];
  const groupIds = [...new Set([...(previous?.keys() ?? []), ...current.keys()])].sort(byText);

  for (const groupId of groupIds) {
    const before = previous?.get(groupId);
    const observed = current.get(groupId);

    if (observed !== undefined && isRebalancing(observed.state)) {
      if (previous === null) settled.set(groupId, null);
      else if (before !== undefined) settled.set(groupId, before);
      continue;
    }

    if (observed !== undefined) settled.set(groupId, observed.members);
    if (previous === null || before === null) continue;

    const after = observed?.members ?? [];
    const was = before ?? [];
    if (shapeOf(was) !== shapeOf(after)) {
      rebalances.push({ groupId, at, membersBefore: was.length, membersAfter: after.length });
    }
  }

  return { settled, rebalances };
};

/** Журнал ребалансов: новые сверху, не длиннее предела. */
export const appendRebalances = (
  journal: readonly PipelineRebalance[],
  fresh: readonly PipelineRebalance[],
  limit: number = REBALANCE_LIMIT,
): PipelineRebalance[] => [...fresh, ...journal].slice(0, limit);
