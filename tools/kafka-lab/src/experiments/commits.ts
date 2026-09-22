import type { Consumer, EachBatchPayload } from 'kafkajs';
import type { Experiment, Lab } from '../experiment.js';

const MESSAGES = 30;
const BLOCK = 10;
const CRASH_AT = 26;
const NO_CRASH = 0;
const TRAP_MESSAGES = 4;
const TRAP_GROUP = 'trap';
const STOP_LIMIT_MS = 25_000;

/** Номер сообщения: значением идёт его порядковый номер, смещение на единицу меньше. */
const numberOf = (value: Buffer | null): number => Number(value?.toString('utf8') ?? '0');

/** Все номера топика по порядку. */
const allNumbers = (): number[] => Array.from({ length: MESSAGES }, (_, index) => index + 1);

/** Номера, не доехавшие до базы. */
const lostNumbers = (rows: readonly number[]): number[] =>
  allNumbers().filter((id) => !rows.includes(id));

/** Номера, записанные в базу больше одного раза. */
const twiceNumbers = (rows: readonly number[]): number[] =>
  allNumbers().filter((id) => rows.filter((row) => row === id).length > 1);

/** Перечень номеров для протокола. */
const listed = (numbers: readonly number[]): string =>
  numbers.length === 0 ? 'ни одного' : numbers.join(', ');

/** Подтверждённая позиция группы в единственной партиции: -1 значит, что не подтверждено ничего. */
const committedOffset = async (lab: Lab, suffix: string, topic: string): Promise<string> => {
  const [entry] = await lab.admin.fetchOffsets({ groupId: lab.groupId(suffix), topics: [topic] });
  return entry?.partitions.at(0)?.offset ?? '-1';
};

/** Падение потребителя: kafkajs сообщает о нём событием CRASH и дальше прогон не идёт. */
const crashWatch = (consumer: Consumer): (() => boolean) => {
  let crashed = false;
  consumer.on(consumer.events.CRASH, () => {
    crashed = true;
  });

  return () => crashed;
};

/** Подтверждение как в packages/kafka/src/consumer.ts: позиция явная, и это следующее смещение. */
const commitThrough = async (payload: EachBatchPayload, offset: string): Promise<void> => {
  payload.resolveOffset(offset);
  await payload.commitOffsetsIfNecessary({
    topics: [
      {
        topic: payload.batch.topic,
        partitions: [
          { partition: payload.batch.partition, offset: (BigInt(offset) + 1n).toString() },
        ],
      },
    ],
  });
};

/** Подтверждение без аргументов: при autoCommit: false kafkajs так не коммитит ничего. */
const commitMute = async (payload: EachBatchPayload, offset: string): Promise<void> => {
  payload.resolveOffset(offset);
  await payload.commitOffsetsIfNecessary();
};

interface RoundParams {
  readonly lab: Lab;
  readonly topic: string;
  readonly rows: number[];
  readonly crashAt: number;
}

/**
 * Группа с автокоммитом: kafkajs подтверждает смещение сразу после обработчика, а в базу номера
 * уходят пачкой по десять, поэтому подтверждение обгоняет работу. Возвращает буфер, не доехавший
 * до базы: при падении он пропадает вместе с процессом.
 */
const autoRound = async (params: RoundParams): Promise<number[]> => {
  const { lab } = params;
  const consumer = await lab.consumer('auto', { retry: { retries: 0 } });
  const crashed = crashWatch(consumer);
  const buffer: number[] = [];
  let last = 0;

  await consumer.subscribe({ topic: params.topic, fromBeginning: true });
  await consumer.run({
    autoCommit: true,
    eachMessage: async (payload) => {
      const id = numberOf(payload.message.value);
      if (id === params.crashAt) throw new Error(`обработчик упал на сообщении ${id}`);

      buffer.push(id);
      if (buffer.length === BLOCK) params.rows.push(...buffer.splice(0, BLOCK));
      await payload.heartbeat();
      last = id;
    },
  });

  if (params.crashAt === NO_CRASH) {
    await lab.waitFor('потребитель с автокоммитом дочитал топик', () => last === MESSAGES, {
      limitMs: STOP_LIMIT_MS,
    });
    params.rows.push(...buffer.splice(0));
    await consumer.disconnect();

    return [];
  }

  await lab.waitFor(`обработчик с автокоммитом упал на сообщении ${params.crashAt}`, crashed, {
    limitMs: STOP_LIMIT_MS,
  });
  await consumer.disconnect();

  return buffer.splice(0);
};

/**
 * Группа с ручным коммитом: номер уходит в базу сразу, а смещение подтверждается раз в десять
 * сообщений, поэтому работа обгоняет подтверждение.
 */
const manualRound = async (params: RoundParams): Promise<void> => {
  const { lab } = params;
  const consumer = await lab.consumer('manual', { retry: { retries: 0 } });
  const crashed = crashWatch(consumer);
  let last = 0;

  await consumer.subscribe({ topic: params.topic, fromBeginning: true });
  await consumer.run({
    autoCommit: false,
    eachBatchAutoResolve: false,
    eachBatch: async (payload) => {
      for (const message of payload.batch.messages) {
        const id = numberOf(message.value);
        if (id === params.crashAt) throw new Error(`обработчик упал на сообщении ${id}`);

        params.rows.push(id);
        if (id % BLOCK === 0) await commitThrough(payload, message.offset);
        await payload.heartbeat();
        last = id;
      }
    },
  });

  if (params.crashAt === NO_CRASH) {
    await lab.waitFor('потребитель с ручным коммитом дочитал топик', () => last === MESSAGES, {
      limitMs: STOP_LIMIT_MS,
    });
  } else {
    await lab.waitFor(`обработчик с ручным коммитом упал на сообщении ${params.crashAt}`, crashed, {
      limitMs: STOP_LIMIT_MS,
    });
  }
  await consumer.disconnect();
};

/**
 * Прогон ловушки: одна группа, пачка подтверждается выбранным способом. Возвращает, с какого
 * смещения потребитель начал, каким кончил и что после него знает о группе брокер.
 */
const trapRound = async (params: {
  readonly lab: Lab;
  readonly topic: string;
  readonly commit: (payload: EachBatchPayload, offset: string) => Promise<void>;
}): Promise<{ readonly from: string; readonly read: string; readonly committed: string }> => {
  const { lab } = params;
  const consumer = await lab.consumer(TRAP_GROUP);
  const lastOffset = String(TRAP_MESSAGES - 1);
  let from = '';
  let read = '';

  await consumer.subscribe({ topic: params.topic, fromBeginning: true });
  await consumer.run({
    autoCommit: false,
    eachBatchAutoResolve: false,
    eachBatch: async (payload) => {
      const first = payload.batch.messages.at(0)?.offset;
      const offset = payload.batch.messages.at(-1)?.offset;
      if (first === undefined || offset === undefined) return;

      if (from === '') from = first;
      await params.commit(payload, offset);
      read = offset;
    },
  });

  await lab.waitFor('группа ловушки дочитала топик', () => read === lastOffset, {
    limitMs: STOP_LIMIT_MS,
  });
  const committed = await committedOffset(lab, TRAP_GROUP, params.topic);
  await consumer.disconnect();

  return { from, read, committed };
};

/** Ожидание пустых групп: группу с живым участником брокер удалять не даёт. */
const settleGroups = async (lab: Lab, suffixes: readonly string[]): Promise<void> => {
  const ids = suffixes.map((suffix) => lab.groupId(suffix));

  await lab.waitFor(
    'учебные группы опустели',
    async () => {
      const { groups } = await lab.admin.describeGroups(ids);
      return groups.every((group) => group.state === 'Empty' || group.state === 'Dead');
    },
    { limitMs: STOP_LIMIT_MS },
  );
};

/** Опыт: автокоммит против ручного и воспроизводимая потеря пачки. */
export const commits: Experiment = {
  name: 'commits',
  title: 'автокоммит против ручного, воспроизводимая потеря пачки',
  run: async (lab) => {
    lab.step(`Учебный топик на одну партицию и ${MESSAGES} сообщений с номерами по порядку.`);
    const topic = await lab.topic('pipe');
    const producer = await lab.producer();
    await producer.send({ topic, messages: allNumbers().map((id) => ({ value: String(id) })) });
    lab.note(`топик ${topic}, смещения 0..${MESSAGES - 1}, номер сообщения больше смещения на 1`);
    lab.note(
      `обе группы читают его с начала, у обеих обработчик падает на сообщении ${CRASH_AT}, ` +
        `шаг работы и шаг подтверждения ${BLOCK} сообщений`,
    );

    lab.step('Автокоммит: смещение подтверждается по сообщению, в базу номера идут пачкой.');
    const autoRows: number[] = [];
    const dropped = await autoRound({ lab, topic, rows: autoRows, crashAt: CRASH_AT });
    const autoStop = await committedOffset(lab, 'auto', topic);
    lab.observe(`в базе ${autoRows.length} номеров, последний ${autoRows.at(-1) ?? 0}`);
    lab.observe(`в буфере упавшего обработчика осталось: ${listed(dropped)}`);
    lab.observe(
      `группа подтвердила смещение ${autoStop}: для брокера сделаны сообщения по ${autoStop}-е`,
    );

    lab.step('Перезапуск: та же группа, новый потребитель, буфер прошлого не пережил падения.');
    await autoRound({ lab, topic, rows: autoRows, crashAt: NO_CRASH });
    const autoLost = lostNumbers(autoRows);
    lab.observe(`потребитель продолжил с сообщения ${Number(autoStop) + 1}`);
    lab.observe(`в базе ${autoRows.length} номеров из ${MESSAGES}`);
    lab.observe(`потеряно ${autoLost.length}: ${listed(autoLost)}`);
    lab.note(
      'при падении обработчика kafkajs с автокоммитом подтверждает всё разобранное: ' +
        'ветка catch в processEachMessage вызывает autoCommitOffsets',
    );

    lab.step('Ручной коммит: номер пишется сразу, подтверждение раз в десять сообщений.');
    const manualRows: number[] = [];
    await manualRound({ lab, topic, rows: manualRows, crashAt: CRASH_AT });
    const manualStop = await committedOffset(lab, 'manual', topic);
    lab.observe(`в базе ${manualRows.length} номеров, последний ${manualRows.at(-1) ?? 0}`);
    lab.observe(
      `группа подтвердила смещение ${manualStop}: сделанное сверх него брокеру не известно`,
    );

    lab.step('Перезапуск: та же группа, новый потребитель, работа с подтверждённой позиции.');
    await manualRound({ lab, topic, rows: manualRows, crashAt: NO_CRASH });
    const manualLost = lostNumbers(manualRows);
    const manualTwice = twiceNumbers(manualRows);
    lab.observe(`потребитель продолжил с сообщения ${Number(manualStop) + 1}`);
    lab.observe(`потеряно ${manualLost.length}: ${listed(manualLost)}`);
    lab.observe(`записано дважды ${manualTwice.length}: ${listed(manualTwice)}`);

    lab.step('Ловушка kafkajs: commitOffsetsIfNecessary() без аргументов при autoCommit: false.');
    const trapTopic = await lab.topic('trap');
    await producer.send({
      topic: trapTopic,
      messages: Array.from({ length: TRAP_MESSAGES }, (_, index) => ({ value: String(index + 1) })),
    });
    const mute = await trapRound({ lab, topic: trapTopic, commit: commitMute });
    lab.observe(
      `обработчик прочитал смещения с ${mute.from} по ${mute.read} и вызвал подтверждение`,
    );
    lab.observe(`группа подтвердила ${mute.committed}, то есть не подтвердила ничего`);
    lab.note(
      'без аргументов вызов уходит в commitOffsetsIfNecessary менеджера смещений, ' +
        'а тот при выключенном автокоммите не видит ни интервала, ни порога и коммит пропускает',
    );

    lab.step('Та же группа с явной позицией, как в packages/kafka/src/consumer.ts.');
    const explicit = await trapRound({ lab, topic: trapTopic, commit: commitThrough });
    lab.observe(
      `новый потребитель начал со смещения ${explicit.from}: подтверждать было нечего, ` +
        'пачка прочитана заново',
    );
    lab.observe(
      `после явного подтверждения группа стоит на ${explicit.committed} при последнем ` +
        `прочитанном ${explicit.read}: коммитится следующее смещение, а не последнее прочитанное`,
    );
    lab.note(
      `позиция ${explicit.read} вместо ${explicit.committed} начинала бы каждый перезапуск ` +
        'с уже обработанного сообщения',
    );
    await settleGroups(lab, ['auto', 'manual', TRAP_GROUP]);

    lab.conclude(
      `порядок между подтверждением и работой решает, чем кончится авария: подтверждение раньше ` +
        `работы даёт дыру в ${autoLost.length} сообщений, работа раньше подтверждения даёт ` +
        `${manualTwice.length} повторов и ноль потерь, а повтор лечится ключом идемпотентности`,
    );
  },
};
