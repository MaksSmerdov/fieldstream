import { describe, expect, it } from 'vitest';
import type { PipelineMember, PipelineRebalance } from '@fieldstream/contracts';
import {
  REBALANCE_LIMIT,
  appendRebalances,
  committedOffset,
  groupLag,
  isStaleGatewayGroup,
  lagSeconds,
  ratePerSec,
  totalLag,
  trackRebalances,
} from '../src/pipeline/pipeline-calc.js';
import type { ObservedGroup, PartitionEnd, SettledShapes } from '../src/pipeline/pipeline-calc.js';

const RAW = 'fieldstream.telemetry.raw.v1';
const STATE = 'fieldstream.device.state.v1';
const AT = '2026-09-14T10:00:00.000Z';

const ends = new Map<string, PartitionEnd[]>([
  [
    RAW,
    [
      { partition: 1, low: 0, high: 40 },
      { partition: 0, low: 5, high: 10 },
    ],
  ],
  [STATE, [{ partition: 0, low: 0, high: 7 }]],
]);

const member = (memberId: string, assignments: PipelineMember['assignments']): PipelineMember => ({
  memberId,
  clientId: 'stream-processor',
  host: '/10.0.0.1',
  assignments,
});

describe('отставание группы', () => {
  it('смещение -1 это «коммита не было», а не нулевая позиция', () => {
    expect(committedOffset('-1')).toBeNull();
    expect(committedOffset('0')).toBe(0);
    expect(committedOffset('42')).toBe(42);
  });

  it('лаг это конец лога минус подтверждённое смещение, по партициям в порядке номеров', () => {
    const rows = groupLag(
      ends,
      [
        {
          topic: RAW,
          partitions: [
            { partition: 0, offset: '4' },
            { partition: 1, offset: '-1' },
          ],
        },
      ],
      [member('m-1', [{ topic: RAW, partitions: [0] }])],
    );

    expect(rows).toEqual([
      { topic: RAW, partition: 0, committed: 4, high: 10, lag: 6, memberId: 'm-1' },
      { topic: RAW, partition: 1, committed: null, high: 40, lag: null, memberId: null },
    ]);
    expect(totalLag(rows)).toBe(6);
  });

  it('смещение за концом лога не даёт отрицательного лага', () => {
    const rows = groupLag(
      ends,
      [{ topic: STATE, partitions: [{ partition: 0, offset: '9' }] }],
      [],
    );

    expect(rows).toEqual([
      { topic: STATE, partition: 0, committed: 9, high: 7, lag: 0, memberId: null },
    ]);
  });

  it('топики группы это назначенные плюс те, где есть коммит; топик без коммитов и раскладки не попадает', () => {
    const rows = groupLag(
      ends,
      [
        { topic: RAW, partitions: [{ partition: 0, offset: '-1' }] },
        { topic: STATE, partitions: [{ partition: 0, offset: '3' }] },
      ],
      [member('m-1', [])],
    );

    expect(rows.map((row) => row.topic)).toEqual([STATE]);

    const assigned = groupLag(ends, [], [member('m-2', [{ topic: RAW, partitions: [0, 1] }])]);
    expect(assigned.map((row) => [row.partition, row.memberId, row.lag])).toEqual([
      [0, 'm-2', null],
      [1, 'm-2', null],
    ]);
  });
});

describe('темп и оценка времени разбора', () => {
  it('на первом опросе темпа нет, дальше это прирост в секунду', () => {
    expect(ratePerSec(null, { value: 100, atMs: 2_000 })).toBeNull();
    expect(ratePerSec({ value: 100, atMs: 0 }, { value: 160, atMs: 2_000 })).toBe(30);
  });

  it('без прошедшего времени темпа нет, а убывание счётчика не даёт отрицательного темпа', () => {
    expect(ratePerSec({ value: 1, atMs: 1_000 }, { value: 5, atMs: 1_000 })).toBeNull();
    expect(ratePerSec({ value: 50, atMs: 0 }, { value: 10, atMs: 1_000 })).toBe(0);
  });

  it('секунды на разбор это лаг, делённый на сумму темпов топиков группы', () => {
    expect(lagSeconds(120, [10, 20])).toBe(4);
    expect(lagSeconds(0, [5])).toBe(0);
  });

  it('неизвестный или нулевой темп не даёт оценки', () => {
    expect(lagSeconds(120, [10, null])).toBeNull();
    expect(lagSeconds(120, [0, 0])).toBeNull();
    expect(lagSeconds(120, [])).toBeNull();
  });
});

describe('группы в снимке', () => {
  it('пустая группа прежнего экземпляра шлюза скрывается, остальные нет', () => {
    expect(isStaleGatewayGroup('fs-api-host-1', 'Empty')).toBe(true);
    expect(isStaleGatewayGroup('fs-api-host-1', 'Stable')).toBe(false);
    expect(isStaleGatewayGroup('fs-processor-raw', 'Empty')).toBe(false);
  });
});

describe('обнаружение ребаланса', () => {
  const LATER = '2026-09-14T10:00:02.000Z';
  const stable = (...members: PipelineMember[]): ObservedGroup => ({ state: 'Stable', members });
  const preparing = (...ids: string[]): ObservedGroup => ({
    state: 'PreparingRebalance',
    members: ids.map((id) => member(id, [])),
  });
  const groups = (observed: ObservedGroup): Map<string, ObservedGroup> =>
    new Map([['g', observed]]);
  const oneMember = stable(member('a', [{ topic: RAW, partitions: [0, 1] }]));
  const twoMembers = stable(
    member('a', [{ topic: RAW, partitions: [0] }]),
    member('b', [{ topic: RAW, partitions: [1] }]),
  );

  /** Прогон цепочки опросов: все записи ребаланса по порядку. */
  const run = (...polls: Map<string, ObservedGroup>[]): PipelineRebalance[] => {
    let settled: SettledShapes | null = null;
    const found: PipelineRebalance[] = [];
    for (const [index, poll] of polls.entries()) {
      const step = trackRebalances(settled, poll, index === 0 ? AT : LATER);
      settled = step.settled;
      found.push(...step.rebalances);
    }
    return found;
  };

  it('первый опрос событий не порождает', () => {
    expect(trackRebalances(null, groups(oneMember), AT).rebalances).toEqual([]);
  });

  it('тот же состав в другом порядке это не ребаланс', () => {
    expect(
      run(
        groups(
          stable(
            member('a', [{ topic: RAW, partitions: [1, 0] }]),
            member('b', [{ topic: STATE, partitions: [0] }]),
          ),
        ),
        groups(
          stable(
            member('b', [{ topic: STATE, partitions: [0] }]),
            member('a', [{ topic: RAW, partitions: [0, 1] }]),
          ),
        ),
      ),
    ).toEqual([]);
  });

  it('вход участника даёт запись с составом до и после', () => {
    expect(run(groups(oneMember), groups(twoMembers))).toEqual([
      { groupId: 'g', at: LATER, membersBefore: 1, membersAfter: 2 },
    ]);
  });

  it('смена раскладки при том же составе тоже ребаланс', () => {
    const moved = stable(member('a', [{ topic: RAW, partitions: [0] }]));

    expect(run(groups(oneMember), groups(moved))).toEqual([
      { groupId: 'g', at: LATER, membersBefore: 1, membersAfter: 1 },
    ]);
  });

  it('исчезновение группы это изменение до нуля участников', () => {
    expect(run(groups(oneMember), new Map())).toEqual([
      { groupId: 'g', at: LATER, membersBefore: 1, membersAfter: 0 },
    ]);
  });

  it('промежуточное состояние с пустыми раскладками не даёт лишних записей', () => {
    const settling = { state: 'CompletingRebalance', members: preparing('a', 'b').members };

    expect(
      run(
        groups(oneMember),
        groups(preparing('a', 'b')),
        groups(settling),
        groups(twoMembers),
        groups(twoMembers),
      ),
    ).toEqual([{ groupId: 'g', at: LATER, membersBefore: 1, membersAfter: 2 }]);
  });

  it('уход участника через ребаланс это одна запись с двух на одного', () => {
    expect(
      run(groups(twoMembers), groups(preparing('a')), groups(oneMember), groups(oneMember)),
    ).toEqual([{ groupId: 'g', at: LATER, membersBefore: 2, membersAfter: 1 }]);
  });

  it('новая группа посреди ребаланса отмечается один раз, когда устоится', () => {
    expect(run(new Map(), groups(preparing('a')), groups(oneMember), groups(oneMember))).toEqual([
      { groupId: 'g', at: LATER, membersBefore: 0, membersAfter: 1 },
    ]);
  });

  it('группа посреди ребаланса на первом опросе, устоявшись, записи не даёт', () => {
    expect(run(groups(preparing('a')), groups(oneMember))).toEqual([]);
  });

  it('группа, исчезнувшая посреди ребаланса, сравнивается с последним устоявшимся составом', () => {
    expect(run(groups(twoMembers), groups(preparing('a', 'b')), new Map())).toEqual([
      { groupId: 'g', at: LATER, membersBefore: 2, membersAfter: 0 },
    ]);
  });

  it('журнал держит новые сверху и не длиннее предела', () => {
    const entry = (index: number): PipelineRebalance => ({
      groupId: `g-${String(index)}`,
      at: AT,
      membersBefore: 1,
      membersAfter: 2,
    });
    const journal = Array.from({ length: REBALANCE_LIMIT }, (_, index) => entry(index));

    const next = appendRebalances(journal, [entry(100)]);

    expect(next).toHaveLength(REBALANCE_LIMIT);
    expect(next[0]?.groupId).toBe('g-100');
    expect(next[1]?.groupId).toBe('g-0');
    expect(next.at(-1)?.groupId).toBe(`g-${String(REBALANCE_LIMIT - 2)}`);
  });
});
