import { TOPIC_NAMES } from '@fieldstream/contracts';
import { formatNumber } from '../stats.js';
import { errorText } from '../report.js';
import type { Bench, Measure, MeasureResult, Row } from '../measure.js';
import {
  hasCommits,
  isStaleGatewayGroup,
  lagText,
  partitionLags,
  totalLag,
  uncommittedText,
} from '../pipeline.js';
import type { PartitionEnd } from '../pipeline.js';

/** Группа брокера глазами замера: состояние и подтверждённые смещения по боевым топикам. */
interface GroupView {
  readonly groupId: string;
  readonly state: string;
  readonly committed: readonly {
    readonly topic: string;
    readonly partitions: readonly { readonly partition: number; readonly offset: string }[];
  }[];
}

/** Концы логов боевых топиков. Недоступный топик не валит замер, а попадает в оговорку. */
const readEnds = async (
  bench: Bench,
): Promise<{ readonly ends: Map<string, PartitionEnd[]>; readonly missing: string[] }> => {
  const ends = new Map<string, PartitionEnd[]>();
  const missing: string[] = [];

  for (const topic of TOPIC_NAMES) {
    try {
      const offsets = await bench.broker.admin.fetchTopicOffsets(topic);
      ends.set(
        topic,
        offsets
          .map((item) => ({
            partition: item.partition,
            low: Number(item.low),
            high: Number(item.high),
          }))
          .sort((left, right) => left.partition - right.partition),
      );
    } catch (error) {
      missing.push(`${topic} (${errorText(error)})`);
    }
  }

  return { ends, missing };
};

/** Что брокер рассказал о группах: живые группы и отброшенные следы прежних экземпляров. */
interface GroupsSeen {
  readonly views: readonly GroupView[];
  readonly stale: readonly string[];
}

/** Живые группы брокера: пустые группы шлюза это следы прежних экземпляров, их видеть не нужно. */
const readGroups = async (bench: Bench): Promise<GroupsSeen> => {
  const { groups: listed } = await bench.broker.admin.listGroups();
  if (listed.length === 0) return { views: [], stale: [] };

  const described = await bench.broker.admin.describeGroups(listed.map((group) => group.groupId));
  const sorted = [...described.groups].sort((left, right) =>
    left.groupId.localeCompare(right.groupId),
  );
  const stale = sorted
    .filter((group) => isStaleGatewayGroup(group.groupId, group.state))
    .map((group) => group.groupId);
  const views: GroupView[] = [];

  for (const group of sorted) {
    if (isStaleGatewayGroup(group.groupId, group.state)) continue;

    const committed = await bench.broker.admin.fetchOffsets({
      groupId: group.groupId,
      topics: [...TOPIC_NAMES],
    });
    views.push({ groupId: group.groupId, state: group.state, committed });
  }

  return { views, stale };
};

/** Строки отставания одной группы: по строке на каждый топик, где у группы есть коммит. */
const rowsOfGroup = (
  group: GroupView,
  ends: ReadonlyMap<string, PartitionEnd[]>,
  how: string,
): { readonly rows: Row[]; readonly total: number } => {
  const rows: Row[] = [];
  let total = 0;

  for (const topic of [...group.committed].sort((left, right) =>
    left.topic.localeCompare(right.topic),
  )) {
    const lags = partitionLags(ends.get(topic.topic) ?? [], topic.partitions);
    if (!hasCommits(lags)) continue;

    const sum = totalLag(lags);
    total += sum;
    const note = uncommittedText(lags);
    rows.push({
      label: `${group.groupId} (${group.state}) → ${topic.topic}`,
      value: `${formatNumber(sum)} сообщений (${lagText(lags)})`,
      how,
      ...(note === null ? {} : { note }),
    });
  }

  return { rows, total };
};

/**
 * Отставание потребителей по боевым топикам. Замер только читает метаданные брокера: смещения
 * групп не трогает и в топики не пишет. Смещение '-1' означает, что коммита не было, и такая
 * партиция отставания не имеет вовсе: трактовка та же, что у шлюза в pipeline-calc.ts.
 */
const run = async (bench: Bench): Promise<MeasureResult> => {
  const { ends, missing } = await readEnds(bench);
  if (missing.length > 0) bench.note(`концы лога не прочитаны у топиков: ${missing.join(', ')}`);

  const { views: groups, stale } = await readGroups(bench);
  bench.note(`живых групп ${groups.length}, боевых топиков ${ends.size}`);
  if (stale.length > 0) {
    bench.note(
      `следами прежних экземпляров шлюза отброшено групп ${stale.length}: ${stale.join(', ')}; ` +
        'они пусты, их отставание в цифры замера не идёт',
    );
  }

  const rows: Row[] = [];
  const silent: string[] = [];
  const counted: string[] = [];
  let total = 0;
  for (const group of groups) {
    const how = bench.broker.how('kafka-consumer-groups.sh', [
      '--describe',
      '--group',
      group.groupId,
    ]);
    const found = rowsOfGroup(group, ends, how);
    if (found.rows.length === 0) silent.push(group.groupId);
    else counted.push(group.groupId);
    rows.push(...found.rows);
    total += found.total;
  }

  const allGroups = bench.broker.how('kafka-consumer-groups.sh', ['--describe', '--all-groups']);
  const countedHow = bench.broker.how(
    'kafka-consumer-groups.sh',
    counted.length === 0
      ? ['--describe', '--all-groups']
      : ['--describe', ...counted.flatMap((groupId) => ['--group', groupId])],
  );
  if (silent.length > 0) {
    bench.note(
      `ни одного коммита в боевых топиках нет у групп: ${silent.join(', ')}; ` +
        'сообщений им пока не приходило, и отставания у них нет',
    );
  }
  if (rows.length === 0) {
    bench.observe('ни одна живая группа не подтвердила смещений в боевых топиках');

    return {
      rows: [
        {
          label: 'Потребители боевых топиков',
          value: `групп с подтверждёнными смещениями нет (живых групп ${groups.length})`,
          how: allGroups,
        },
      ],
      note: 'Пустые группы шлюза с префиксом fs-api- в замер не идут: это следы прежних экземпляров.',
    };
  }

  return {
    rows: [
      ...rows,
      {
        label: 'Суммарное отставание живых групп',
        value: `${formatNumber(total)} сообщений по ${rows.length} парам группа-топик`,
        how: countedHow,
        note:
          `в сумму вошли группы: ${counted.join(', ')}` +
          (stale.length === 0
            ? ''
            : `; сверх них ${allGroups} покажет ещё ${stale.length} пустых групп ` +
              `(${stale.join(', ')}): это следы прежних экземпляров шлюза, ` +
              'их отставание в сумму не входит'),
      },
    ],
    note:
      'Снято чтением метаданных брокера: концы партиций против подтверждённых смещений групп. ' +
      'Партиция без коммита отставания не имеет и в сумму не входит, пустые группы шлюза ' +
      'с префиксом fs-api- пропущены как следы прежних экземпляров.',
  };
};

export const lag: Measure = {
  name: 'lag',
  title: 'отставание потребителей по боевым топикам',
  needs: ['kafka'],
  run,
};
