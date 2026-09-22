import { Partitioners } from 'kafkajs';
import type { PartitionMetadata } from 'kafkajs';
import type { Experiment, Lab } from '../experiment.js';

/** Приборы стенда: двенадцать контроллеров и двенадцать счётчиков, коды как в packages/device-profiles. */
const DEVICE_CODES: readonly string[] = [
  ...Array.from({ length: 12 }, (_, index) => `RC-${101 + index}`),
  ...Array.from({ length: 12 }, (_, index) => `PM-${201 + index}`),
];

/** Учебный топик уже боевого: на трёх партициях раскладка видна целиком. */
const PARTITIONS = 3;
const ROUNDS = 5;
const TOTAL = ROUNDS * DEVICE_CODES.length;

/** Поток без ключа снимается с одного прибора: так видно, что теряется именно его порядок. */
const PLAIN_DEVICE = 'RC-101';
const PLAIN_COUNT = 12;

const READ_LIMIT_MS = 20_000;
const SHOWN = 12;

/** Боевые топики стенда: опыт читает у них только метаданные. */
const STAND_TOPICS: readonly string[] = [
  'fieldstream.telemetry.raw.v1',
  'fieldstream.collector.cycles.v2',
  'fieldstream.alarms.events.v1',
];

/** Тело учебного сообщения: прибор, номер в общем потоке отправки и номер в потоке прибора. */
interface Sent {
  readonly device: string;
  readonly order: number;
  readonly nth: number;
}

/** Прочитанное сообщение: из какой партиции пришло и каким по счёту. */
interface Got {
  readonly partition: number;
  readonly arrival: number;
  readonly sent: Sent;
}

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

/** Партиция ключа: считает тот же разделитель kafkajs, что стоит у продюсера проекта. */
const partitionForKey = (key: string, partitions: number): number =>
  partitioner({
    topic: 'partition-for-key',
    partitionMetadata: metadataOf(partitions),
    message: { key, value: null },
  });

/** Раскладка по партициям строкой: 0: 40, 1: 40, 2: 40. */
const spreadText = (counts: readonly number[]): string =>
  counts.map((count, partition) => `${partition}: ${count}`).join(', ');

/** Сколько сообщений попало в каждую партицию. */
const countByPartition = (items: readonly Got[], partitions: number): number[] =>
  Array.from(
    { length: partitions },
    (_, partition) => items.filter((item) => item.partition === partition).length,
  );

/** Растут ли номера от сообщения к сообщению: так проверяется порядок внутри одного ключа. */
const isOrdered = (values: readonly number[]): boolean =>
  values.every(
    (value, index) => index === 0 || value > (values[index - 1] ?? Number.NEGATIVE_INFINITY),
  );

/** Сколько сообщений подряд от начала чтения пришло из одной партиции. */
const firstStreak = (items: readonly Got[]): number => {
  const first = items[0];
  if (first === undefined) return 0;

  const tail = items.findIndex((item) => item.partition !== first.partition);
  return tail === -1 ? items.length : tail;
};

/** Разбор тела: опыт кладёт в сообщение три поля и ждёт их обратно. */
const parseSent = (raw: Buffer | null): Sent => {
  if (raw === null) throw new Error('учебное сообщение пришло без тела');

  const value: unknown = JSON.parse(raw.toString('utf8'));
  if (typeof value !== 'object' || value === null) throw new Error('тело сообщения не объект');

  const { device, order, nth } = value as Record<string, unknown>;
  if (typeof device !== 'string' || typeof order !== 'number' || typeof nth !== 'number') {
    throw new Error('в теле сообщения нет полей device, order и nth');
  }

  return { device, order, nth };
};

/** Чтение топика целиком одной группой: сообщения возвращаются в порядке прихода. */
const readAll = async (
  lab: Lab,
  topic: string,
  groupSuffix: string,
  total: number,
): Promise<Got[]> => {
  const got: Got[] = [];
  const consumer = await lab.consumer(groupSuffix);

  await consumer.subscribe({ topic, fromBeginning: true });
  await consumer.run({
    eachMessage: ({ partition, message }) => {
      got.push({ partition, arrival: got.length + 1, sent: parseSent(message.value) });
      return Promise.resolve();
    },
  });
  await lab.waitFor(`группа прочитала ${total} сообщений из ${topic}`, () => got.length >= total, {
    limitMs: READ_LIMIT_MS,
  });
  await consumer.stop();

  return got;
};

/** Поток с ключом: каждый круг раздаёт по одному сообщению каждому прибору. */
const keyedRound = (round: number): { key: string; value: string }[] =>
  DEVICE_CODES.map((device, index) => ({
    key: device,
    value: JSON.stringify({
      device,
      order: round * DEVICE_CODES.length + index + 1,
      nth: round + 1,
    }),
  }));

/** Тот же поток одного прибора, но без ключа: партицию выбирает не он. */
const plainRound = (): { key: null; value: string }[] =>
  Array.from({ length: PLAIN_COUNT }, (_, index) => ({
    key: null,
    value: JSON.stringify({ device: PLAIN_DEVICE, order: index + 1, nth: index + 1 }),
  }));

/** Прогон опыта: ключ, партиции, порядок внутри ключа и его отсутствие между партициями. */
const run = async (lab: Lab): Promise<void> => {
  const keyed = await lab.topic('telemetry', { partitions: PARTITIONS });
  const plainTopic = await lab.topic('telemetry-nokey', { partitions: PARTITIONS });

  lab.step(`учебный топик ${keyed} на ${PARTITIONS} партиции, ключ это код прибора`);
  lab.note(`приборов ${DEVICE_CODES.length}: RC-101..RC-112 и PM-201..PM-212, как на стенде`);

  const plan = DEVICE_CODES.map((device) => ({
    device,
    partition: partitionForKey(device, PARTITIONS),
  }));
  const planned = Array.from(
    { length: PARTITIONS },
    (_, partition) => plan.filter((item) => item.partition === partition).length,
  );

  lab.step('партиция каждого ключа посчитана заранее разделителем продюсера проекта');
  lab.observe(`приборов по партициям ожидается ${spreadText(planned)}`);
  lab.note(
    plan
      .slice(0, 4)
      .map((item) => `${item.device} в ${item.partition}`)
      .join(', '),
  );

  const producer = await lab.producer({
    createPartitioner: Partitioners.DefaultPartitioner,
    idempotent: true,
  });
  const sendTimer = lab.timer();

  for (let round = 0; round < ROUNDS; round += 1) {
    await producer.send({ topic: keyed, acks: -1, messages: keyedRound(round) });
  }

  lab.step(`${TOTAL} сообщений отправлены ${ROUNDS} кругами, на круге по одному каждому прибору`);
  lab.observe(`отправка заняла ${sendTimer.text()}, номер в общем потоке едет в теле сообщения`);

  const got = await readAll(lab, keyed, 'reader', TOTAL);
  const spread = new Map<string, Set<number>>();
  const streams = new Map<string, number[]>();

  for (const item of got) {
    const partitions = spread.get(item.sent.device) ?? new Set<number>();
    partitions.add(item.partition);
    spread.set(item.sent.device, partitions);

    const stream = streams.get(item.sent.device) ?? [];
    stream.push(item.sent.nth);
    streams.set(item.sent.device, stream);
  }

  const single = [...spread.values()].filter((partitions) => partitions.size === 1).length;
  const asPlanned = plan.filter((item) => {
    const partitions = spread.get(item.device);
    return partitions !== undefined && partitions.size === 1 && partitions.has(item.partition);
  }).length;
  const ordered = [...streams.values()].filter((stream) => isOrdered(stream)).length;

  lab.step(`топик прочитан одной группой с начала: ${got.length} сообщений`);
  lab.observe(`сообщений по партициям ${spreadText(countByPartition(got, PARTITIONS))}`);
  lab.observe(
    `ключей ровно в одной партиции ${single} из ${DEVICE_CODES.length}, с расчётом совпало ${asPlanned}`,
  );
  lab.observe(`порядок внутри ключа сохранён у ${ordered} приборов из ${DEVICE_CODES.length}`);

  const inPlace = got.filter((item, index) => item.sent.order === index + 1).length;
  const maxShift = got.reduce(
    (max, item, index) => Math.max(max, Math.abs(item.sent.order - (index + 1))),
    0,
  );

  lab.step('порядок чтения топика против порядка отправки');
  lab.observe(
    `сообщений на своём месте: ${inPlace} из ${got.length}, наибольший сдвиг ${maxShift}`,
  );
  lab.observe(`первые ${firstStreak(got)} сообщений пришли из одной партиции`);
  lab.note(
    `первые ${SHOWN} номеров отправки в порядке чтения: ` +
      got
        .slice(0, SHOWN)
        .map((item) => item.sent.order)
        .join(', '),
  );

  await producer.send({ topic: plainTopic, acks: -1, messages: plainRound() });
  const plain = await readAll(lab, plainTopic, 'reader-nokey', PLAIN_COUNT);
  const plainOrdered = isOrdered(plain.map((item) => item.sent.order));
  const plainInPlace = plain.filter((item, index) => item.sent.order === index + 1).length;

  lab.step(`${PLAIN_COUNT} сообщений одного прибора ${PLAIN_DEVICE} отправлены без ключа`);
  lab.observe(`сообщений по партициям ${spreadText(countByPartition(plain, PARTITIONS))}`);
  lab.observe(
    `порядок прибора при чтении ${plainOrdered ? 'сохранился' : 'нарушен'}, ` +
      `сообщений на своём месте: ${plainInPlace} из ${plain.length}`,
  );
  lab.note('номера отправки в порядке чтения: ' + plain.map((item) => item.sent.order).join(', '));

  const metadata = await lab.admin.fetchTopicMetadata({ topics: [...STAND_TOPICS] });

  lab.step('боевые топики стенда: прочитаны только метаданные');
  for (const topic of metadata.topics) {
    lab.note(
      `${topic.name}: партиций ${topic.partitions.length}, ` +
        `${PLAIN_DEVICE} лёг бы в партицию ${partitionForKey(PLAIN_DEVICE, topic.partitions.length)}`,
    );
  }

  lab.conclude(
    'ключ выбирает партицию, партиция держит порядок. Ключей, легших ровно в одну партицию и ' +
      `пришедших в порядке отправки: ${single} из ${DEVICE_CODES.length}. Сообщений, пришедших ` +
      `на своём месте в общем потоке топика: ${inPlace} из ${got.length}. Без ключа тот же поток ` +
      'одного прибора размазался по всем партициям и порядок потерял.',
  );
};

/** Опыт: порядок и партиционирование по ключу. */
export const order: Experiment = {
  name: 'order',
  title: 'порядок и партиционирование по ключу',
  run,
};
