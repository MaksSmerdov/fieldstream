import { Partitioners } from 'kafkajs';
import type { Consumer, IMemberAssignment, PartitionMetadata, Producer } from 'kafkajs';
import type { Experiment, Lab, LabTimer } from '../experiment.js';

/** Раскладка: партиции каждого топика так, как экземпляр получил их в назначении. */
type Layout = Readonly<Record<string, readonly number[]>>;

/** Поток в учебные топики: сколько ушло, сколько не ушло и как его остановить. */
interface Flow {
  readonly sent: () => number;
  readonly failed: () => number;
  readonly stop: () => Promise<void>;
}

/** Экземпляр потребителя под наблюдением: назначения из событий и разрывы в обработке. */
interface Instance {
  readonly consumer: Consumer;
  readonly layout: () => Layout;
  readonly joins: () => number;
  readonly joinMs: () => number;
  readonly handled: () => number;
  readonly mark: () => void;
  readonly gapMs: () => number;
}

const PARTITIONS = 3;
const GROUP_SUFFIX = 'ride';
const DEVICES = [
  'RC-101',
  'RC-102',
  'RC-103',
  'RC-104',
  'RC-105',
  'RC-106',
  'PM-201',
  'PM-202',
  'PM-203',
  'PM-204',
  'PM-205',
  'PM-206',
] as const;
const SEND_STEP_MS = 60;
const CYCLE_EVERY = 5;
const CALM_MS = 6_000;
const SETTLE_MS = 8_000;
const JOIN_LIMIT_MS = 30_000;

const partitioner = Partitioners.DefaultPartitioner();

/** Метаданные топика нужной длины: разделителю по ключу важно только число партиций. */
const metadataOf = (partitions: number): PartitionMetadata[] =>
  Array.from({ length: partitions }, (_, partitionId) => ({
    partitionErrorCode: 0,
    partitionId,
    leader: 0,
    replicas: [0],
    isr: [0],
  }));

/** Партиция ключа по тому же разделителю, каким кладёт сообщения продюсер. */
const partitionOfKey = (key: string): number =>
  partitioner({
    topic: 'kafka-lab',
    partitionMetadata: metadataOf(PARTITIONS),
    message: { key, value: null },
  });

/** Приборы, чьи ключи ведут в эти партиции: так процессор считает свои приборы по назначению. */
const devicesOf = (partitions: readonly number[]): string[] =>
  DEVICES.filter((code) => partitions.includes(partitionOfKey(code)));

/** Короткое имя топика: полное занимает полстроки протокола. */
const shortName = (topic: string): string => topic.slice(topic.lastIndexOf('.') + 1);

/** Раскладка из назначения: короткие имена топиков, партиции по возрастанию. */
const layoutOf = (assignment: IMemberAssignment): Layout =>
  Object.fromEntries(
    Object.entries(assignment).map(([topic, partitions]) => [
      shortName(topic),
      [...partitions].sort((left, right) => left - right),
    ]),
  );

/** Раскладка строкой: raw [0, 2], cycles [1]. */
const layoutText = (layout: Layout): string => {
  const parts = Object.entries(layout).map(
    ([topic, partitions]) => `${topic} [${partitions.join(', ')}]`,
  );

  return parts.length === 0 ? 'ничего' : parts.join(', ');
};

/** У кого партиция с этим номером: раскладки двух экземпляров вместе покрывают весь топик. */
const ownerOf = (partition: number, topic: string, first: Layout, second: Layout): string => {
  if ((first[topic] ?? []).includes(partition)) return 'первого';
  if ((second[topic] ?? []).includes(partition)) return 'второго';

  return 'никого';
};

/** Партиции топика, которых в новом назначении не стало: события об их отзыве не приходит. */
const takenAway = (before: Layout, after: Layout, topic: string): number[] => {
  const kept = new Set(after[topic] ?? []);

  return [...(before[topic] ?? [])].filter((partition) => !kept.has(partition));
};

/** Непрерывный поток: кадр каждые SEND_STEP_MS, ключ это код прибора по кругу, цикл опроса реже. */
const startFlow = (
  lab: Lab,
  clock: LabTimer,
  producer: Producer,
  raw: string,
  cycles: string,
): Flow => {
  let running = true;
  let step = 0;
  let sent = 0;
  let failed = 0;
  const alive = (): boolean => running;

  const loop = (async (): Promise<void> => {
    while (alive()) {
      const device = DEVICES[step % DEVICES.length] ?? DEVICES[0];
      const value = JSON.stringify({ device, ms: Math.round(clock.ms()) });

      try {
        await producer.send({ topic: raw, messages: [{ key: device, value }] });
        sent += 1;
        if (step % CYCLE_EVERY === 0) {
          await producer.send({ topic: cycles, messages: [{ key: device, value }] });
          sent += 1;
        }
      } catch {
        failed += 1;
      }
      step += 1;
      await lab.sleep(SEND_STEP_MS);
    }
  })();

  return {
    sent: () => sent,
    failed: () => failed,
    stop: async () => {
      running = false;
      await loop;
    },
  };
};

/** Экземпляр в учебной группе: подписан на оба топика, считает обработанное и разрывы в обработке. */
const startInstance = async (
  lab: Lab,
  clock: LabTimer,
  topics: readonly string[],
): Promise<Instance> => {
  const consumer = await lab.consumer(GROUP_SUFFIX);
  let layout: Layout = {};
  let joins = 0;
  let joinMs = 0;
  let handled = 0;
  let lastAt = clock.ms();
  let gap = 0;

  consumer.on(consumer.events.GROUP_JOIN, (event) => {
    joins += 1;
    joinMs = event.payload.duration;
    layout = layoutOf(event.payload.memberAssignment);
  });

  await consumer.subscribe({ topics: [...topics] });
  await consumer.run({
    eachMessage: () => {
      const now = clock.ms();
      gap = Math.max(gap, now - lastAt);
      lastAt = now;
      handled += 1;
      return Promise.resolve();
    },
  });

  return {
    consumer,
    layout: () => layout,
    joins: () => joins,
    joinMs: () => joinMs,
    handled: () => handled,
    mark: () => {
      gap = 0;
      lastAt = clock.ms();
    },
    gapMs: () => gap,
  };
};

/** Опыт: ребаланс при добавлении второго экземпляра. */
export const rebalance: Experiment = {
  name: 'rebalance',
  title: 'ребаланс при добавлении второго экземпляра',
  run: async (lab) => {
    const clock = lab.timer();
    const raw = await lab.topic('raw', { partitions: PARTITIONS });
    const cycles = await lab.topic('cycles', { partitions: PARTITIONS });
    const topics = [raw, cycles];

    lab.step(`два топика по ${PARTITIONS} партиции: ${shortName(raw)} и ${shortName(cycles)}`);
    for (let partition = 0; partition < PARTITIONS; partition += 1) {
      lab.note(`партиция ${partition}: ${devicesOf([partition]).join(', ')}`);
    }
    const producer = await lab.producer();
    const flow = startFlow(lab, clock, producer, raw, cycles);
    lab.note(
      `поток пошёл: кадр каждые ${SEND_STEP_MS} мс, цикл опроса каждый ${CYCLE_EVERY}-й кадр`,
    );

    lab.step('первый экземпляр входит в группу');
    const first = await startInstance(lab, clock, topics);
    await lab.waitFor('первый экземпляр получил назначение', () => first.joins() > 0, {
      limitMs: JOIN_LIMIT_MS,
    });
    const events = Object.values(first.consumer.events);
    lab.observe(
      `назначение пришло целиком: ${layoutText(first.layout())}, вступление заняло ${first.joinMs()} мс`,
    );
    lab.observe(
      `событий отзыва партиций у kafkajs нет: среди ${events.length} событий потребителя ни одного ` +
        'со словом revoke, о группе говорят consumer.rebalancing и consumer.group_join',
    );

    lab.step(`спокойный поток: ${CALM_MS / 1000} с без изменений в группе`);
    const calmFrom = first.handled();
    first.mark();
    await lab.sleep(CALM_MS);
    const calmGap = Math.round(first.gapMs());
    lab.observe(
      `первый обработал ${first.handled() - calmFrom} сообщений, самый долгий разрыв между ними ${calmGap} мс`,
    );

    lab.step('второй экземпляр входит в ту же группу');
    const before = first.layout();
    const joinsBefore = first.joins();
    first.mark();
    const move = lab.timer();
    const second = await startInstance(lab, clock, topics);
    await lab.waitFor(
      'группа пересобралась на двоих',
      () => first.joins() > joinsBefore && second.joins() > 0,
      { limitMs: JOIN_LIMIT_MS },
    );
    const moveText = move.text();
    await lab.sleep(SETTLE_MS);

    lab.observe(
      `переезд занял ${moveText} с запуска второго, kafkajs отчитался о вступлении за ` +
        `${first.joinMs()} мс у первого и ${second.joinMs()} мс у второго`,
    );
    lab.observe(
      `обработка на первом встала на ${Math.round(first.gapMs())} мс, в спокойное время самый долгий разрыв был ${calmGap} мс`,
    );
    lab.observe(`первый: ${layoutText(first.layout())}`);
    lab.observe(`второй: ${layoutText(second.layout())}`);

    const gone = takenAway(before, first.layout(), shortName(raw));
    lab.observe(
      `у первого убыли партиции ${shortName(raw)} [${gone.join(', ')}]: события об отзыве не было, ` +
        'разницу опыт посчитал сам, сравнив прошлое назначение с новым',
    );
    lab.observe(`вместе с партициями уехали приборы ${devicesOf(gone).join(', ')}`);

    const split = Array.from({ length: PARTITIONS }, (_, partition) => ({
      partition,
      raw: ownerOf(partition, shortName(raw), first.layout(), second.layout()),
      cycles: ownerOf(partition, shortName(cycles), first.layout(), second.layout()),
    }));
    const apart = split.filter((row) => row.raw !== row.cycles);
    lab.observe(
      apart.length === 0
        ? 'партиции с одним номером в обоих топиках достались одному экземпляру: так совпало'
        : `партиции с одним номером разъехались у ${apart.length} номеров из ${PARTITIONS}: ` +
            'штатный назначатель kafkajs раскладывает партиции обоих топиков одним списком',
    );
    for (const row of split) {
      lab.note(
        `партиция ${row.partition}: ${shortName(raw)} у ${row.raw}, ${shortName(cycles)} у ${row.cycles}`,
      );
    }

    lab.step('второй экземпляр уходит из группы');
    const leaveJoins = first.joins();
    first.mark();
    const back = lab.timer();
    await second.consumer.disconnect();
    await lab.waitFor('группа пересобралась на одного', () => first.joins() > leaveJoins, {
      limitMs: JOIN_LIMIT_MS,
    });
    const backText = back.text();
    await lab.sleep(SETTLE_MS);
    lab.observe(
      `обратный переезд занял ${backText}, обработка встала на ${Math.round(first.gapMs())} мс`,
    );
    lab.observe(`первому снова назначено всё целиком: ${layoutText(first.layout())}`);
    lab.observe(`назначений за прогон: первому ${first.joins()}, второму ${second.joins()}`);

    lab.step('поток остановлен');
    await flow.stop();
    lab.observe(
      `отправлено ${flow.sent()} сообщений, обработано первым ${first.handled()}, вторым ${second.handled()}`,
    );
    lab.note('кадры до первого вступления в группу не читал никто: группа новая, чтение с конца');
    if (flow.failed() > 0) lab.note(`отправок с отказом: ${flow.failed()}`);

    lab.conclude(
      'назначение приходит целиком и только новое, поэтому отобранное считается разницей с прошлым ' +
        'назначением, как handoverOf в services/stream-processor/src/ingest/assignment.ts. ' +
        'Пока группа переезжает, не обрабатывает никто, и подъём состояния приборов из базы обязан ' +
        'укладываться в эту же паузу.',
    );
  },
};
