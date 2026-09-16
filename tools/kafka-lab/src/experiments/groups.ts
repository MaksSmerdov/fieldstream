import type { Consumer, Message, Producer } from 'kafkajs';
import type { Experiment, Lab } from '../experiment.js';

const PARTITIONS = 6;
const FIRST_BATCH = 10;
const SECOND_BATCH = 2;
const THIRD_BATCH = 1;
const CROWD_SIZE = 8;
const JOIN_LIMIT_MS = 40_000;
const READ_LIMIT_MS = 20_000;
const SETTLE_MS = 700;

/** Участник группы: потребитель, его последнее назначение и прочитанное по партициям. */
interface Member {
  readonly label: string;
  readonly consumer: Consumer;
  readonly seen: Map<number, number>;
  joins: number;
  assigned: readonly number[];
}

/** Что нужно для подключения участника: топик, суффикс группы, имя в протоколе и точка чтения. */
interface JoinOptions {
  readonly topic: string;
  readonly suffix: string;
  readonly label: string;
  readonly fromBeginning: boolean;
}

/** Сколько сообщений участник прочитал с последней отметки. */
const readBy = (member: Member): number =>
  [...member.seen.values()].reduce((sum, count) => sum + count, 0);

/** Сколько прочитали все участники вместе. */
const readByAll = (members: readonly Member[]): number =>
  members.reduce((sum, member) => sum + readBy(member), 0);

/** Число со словом «сообщение» в нужной форме: протокол читает человек. */
const messagesOf = (count: number): string => {
  const hundred = count % 100;
  const ten = count % 10;

  if (hundred >= 11 && hundred <= 14) return `${count} сообщений`;
  if (ten === 1) return `${count} сообщение`;
  if (ten >= 2 && ten <= 4) return `${count} сообщения`;

  return `${count} сообщений`;
};

/** Номера партиций списком: 0,2,4 или прочерк, если участнику ничего не досталось. */
const listOf = (partitions: readonly number[]): string =>
  partitions.length === 0 ? 'нет' : partitions.join(',');

/** Из каких партиций участнику пришли сообщения. */
const seenIn = (member: Member): string => listOf([...member.seen.keys()].sort((a, b) => a - b));

/** Отметка, от которой считается следующий кусок работы. */
const resetSeen = (members: readonly Member[]): void => {
  for (const member of members) member.seen.clear();
};

/** Сколько раз каждый участник входил в группу: точка отсчёта для следующего ребаланса. */
const joinsOf = (members: readonly Member[]): number[] => members.map((member) => member.joins);

/** Подключение участника: он запоминает своё назначение и считает прочитанное по партициям. */
const join = async (lab: Lab, options: JoinOptions): Promise<Member> => {
  const consumer = await lab.consumer(options.suffix);
  const member: Member = {
    label: options.label,
    consumer,
    seen: new Map(),
    joins: 0,
    assigned: [],
  };

  consumer.on(consumer.events.GROUP_JOIN, ({ payload }) => {
    member.assigned = [...(payload.memberAssignment[options.topic] ?? [])].sort((a, b) => a - b);
    member.joins += 1;
  });
  await consumer.subscribe({ topic: options.topic, fromBeginning: options.fromBeginning });
  await consumer.run({
    eachMessage: ({ partition }) => {
      member.seen.set(partition, (member.seen.get(partition) ?? 0) + 1);
      return Promise.resolve();
    },
  });

  return member;
};

/** Группа собрана: брокер видит её в состоянии Stable с ожидаемым числом участников. */
const stable = async (lab: Lab, groupId: string, size: number): Promise<boolean> => {
  const described = await lab.admin.describeGroups([groupId]);
  const [group] = described.groups;

  return group?.state === 'Stable' && group.members.length === size;
};

/**
 * Ожидание устоявшейся раскладки: группа собрана по мнению брокера, каждый участник получил
 * назначение новее отметки, а партиции разобраны целиком и без пересечений. Промежуточное
 * поколение группы такой проверки не проходит, и работа не начинается посреди ребаланса.
 */
const settled = async (
  lab: Lab,
  groupId: string,
  members: readonly Member[],
  since: readonly number[],
): Promise<void> => {
  await lab.waitFor(
    `группа ${groupId} собралась и раздала ${PARTITIONS} партиций, участников ${members.length}`,
    async () => {
      if (!(await stable(lab, groupId, members.length))) return false;
      const rejoined = members.every((member, index) => member.joins > (since[index] ?? 0));
      const taken = members.flatMap((member) => [...member.assigned]);

      return rejoined && taken.length === PARTITIONS && new Set(taken).size === PARTITIONS;
    },
    { limitMs: JOIN_LIMIT_MS },
  );
};

/** Ожидание, пока участники разберут ожидаемое число сообщений, и пауза на возможные лишние. */
const readAll = async (lab: Lab, members: readonly Member[], expected: number): Promise<void> => {
  await lab.waitFor(
    `участники прочитали ${messagesOf(expected)}`,
    () => readByAll(members) >= expected,
    { limitMs: READ_LIMIT_MS },
  );
  await lab.sleep(SETTLE_MS);
};

/** Раскладка в протокол: кто сколько партиций держит и какие именно. */
const layout = (lab: Lab, members: readonly Member[]): void => {
  for (const member of members) {
    lab.note(
      `${member.label}: партиций ${member.assigned.length}, номера ${listOf(member.assigned)}`,
    );
  }
};

/** Наполнение топика: партиция задана явно, поэтому во всех лежит одинаковое число сообщений. */
const fill = async (producer: Producer, topic: string, perPartition: number): Promise<number> => {
  const messages: Message[] = [];

  for (let partition = 0; partition < PARTITIONS; partition += 1) {
    for (let index = 0; index < perPartition; index += 1) {
      messages.push({
        partition,
        key: `rig-${partition}`,
        value: JSON.stringify({ partition, index }),
      });
    }
  }
  await producer.send({ topic, messages, acks: -1 });

  return messages.length;
};

/** Сколько сообщений лежит в топике: сумма конечных смещений по партициям. */
const stored = async (lab: Lab, topic: string): Promise<number> => {
  const offsets = await lab.admin.fetchTopicOffsets(topic);

  return offsets.reduce((sum, item) => sum + Number(item.high), 0);
};

/** Сколько группа отметила прочитанным: сумма подтверждённых смещений по партициям. */
const committedBy = async (lab: Lab, groupId: string, topic: string): Promise<number> => {
  const [entry] = await lab.admin.fetchOffsets({ groupId, topics: [topic] });

  return (entry?.partitions ?? []).reduce((sum, item) => sum + Math.max(Number(item.offset), 0), 0);
};

/** Прогон опыта: одна группа делит партиции, чужая группа читает тот же поток сама по себе. */
const run = async (lab: Lab): Promise<void> => {
  const topic = await lab.topic('stream', { partitions: PARTITIONS });
  const producer = await lab.producer();
  const work = lab.groupId('work');
  const audit = lab.groupId('audit');
  const crowd = lab.groupId('crowd');

  lab.step(`топик ${topic} на ${PARTITIONS} партиций и первая партия сообщений`);
  const first = await fill(producer, topic, FIRST_BATCH);
  lab.observe(
    `записано ${messagesOf(first)}, по ${FIRST_BATCH} в партицию; в топике лежит ${await stored(lab, topic)}`,
  );

  lab.step(`один участник в группе ${work}`);
  const alone = lab.timer();
  const a = await join(lab, { topic, suffix: 'work', label: 'A', fromBeginning: true });
  await settled(lab, work, [a], [0]);
  layout(lab, [a]);
  await readAll(lab, [a], first);
  lab.observe(
    `A держит все ${PARTITIONS} партиций и прочитал ${messagesOf(readBy(a))} за ${alone.text()}`,
  );

  lab.step(`второй участник в той же группе ${work}`);
  const since = joinsOf([a]);
  const shuffle = lab.timer();
  const b = await join(lab, { topic, suffix: 'work', label: 'B', fromBeginning: true });
  await settled(lab, work, [a, b], [...since, 0]);
  lab.observe(`группа пересобралась за ${shuffle.text()}, партиции разошлись на двоих`);
  layout(lab, [a, b]);

  resetSeen([a, b]);
  const second = await fill(producer, topic, SECOND_BATCH);
  await readAll(lab, [a, b], second);
  lab.note(`A: ${messagesOf(readBy(a))} из партиций ${seenIn(a)}`);
  lab.note(`B: ${messagesOf(readBy(b))} из партиций ${seenIn(b)}`);
  lab.observe(
    `из ${second} новых сообщений A взял ${readBy(a)}, B взял ${readBy(b)}, вместе ${readByAll([a, b])}`,
  );

  lab.step(`потребитель в другой группе ${audit}`);
  resetSeen([a, b]);
  const total = await stored(lab, topic);
  const c = await join(lab, { topic, suffix: 'audit', label: 'C', fromBeginning: true });
  await settled(lab, audit, [c], [0]);
  layout(lab, [c]);
  await readAll(lab, [c], total);
  lab.observe(`C прочитал ${messagesOf(readBy(c))} с начала топика, где лежит ${total}`);
  lab.observe(`участники ${work} получили за это время ${messagesOf(readByAll([a, b]))}`);
  lab.note(
    `подтверждено смещений из ${total}: ${work} ${await committedBy(lab, work, topic)}, ` +
      `${audit} ${await committedBy(lab, audit, topic)}`,
  );

  lab.step(`${CROWD_SIZE} участников на ${PARTITIONS} партиций в группе ${crowd}`);
  const crowded = lab.timer();
  const members = await Promise.all(
    Array.from({ length: CROWD_SIZE }, (_, index) =>
      join(lab, { topic, suffix: 'crowd', label: `K${index + 1}`, fromBeginning: false }),
    ),
  );
  await settled(
    lab,
    crowd,
    members,
    members.map(() => 0),
  );
  layout(lab, members);
  const idle = members.filter((member) => member.assigned.length === 0);
  lab.observe(
    `за ${crowded.text()} партиции достались ${CROWD_SIZE - idle.length} участникам по одной, ` +
      `без партиций остались ${idle.length}: ${idle.map((member) => member.label).join(', ')}`,
  );

  const third = await fill(producer, topic, THIRD_BATCH);
  await readAll(lab, members, third);
  lab.observe(
    `из ${third} новых сообщений участники с партициями прочитали ${readByAll(members) - readByAll(idle)}, ` +
      `простаивающие ${readByAll(idle)}`,
  );

  lab.conclude(
    `партиция это единица работы группы: ${PARTITIONS} партиций делятся между участниками одной ` +
      `группы без пересечений, лишние участники сверх числа партиций стоят без дела, ` +
      `а другая группа читает тот же топик со своими смещениями и видит все ${messagesOf(total)}`,
  );
};

/** Опыт: группы потребителей и распределение работы. */
export const groups: Experiment = {
  name: 'groups',
  title: 'группы потребителей и распределение работы',
  run,
};
