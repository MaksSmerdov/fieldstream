import kafkajs from 'kafkajs';
import type { Experiment, Lab } from '../experiment.js';

/** Перечисления kafkajs видны только через общий модуль: имена собраны не статически. */
const { ConfigResourceTypes } = kafkajs;

/** Приборы опыта: на каждый ключ пишется своя череда версий состояния. */
const DEVICES = [
  { key: 'DEV-1001', versions: 6 },
  { key: 'DEV-1002', versions: 4 },
  { key: 'DEV-1003', versions: 3 },
] as const;

/** Прибор, который потом удаляется надгробием. */
const DOOMED_KEY = 'DEV-1003';

/** Ключ, которым закрывается сегмент: активный сегмент брокер не уплотняет. */
const BOUNDARY_KEY = 'SEGMENT-BOUNDARY';

/**
 * Сжатие под опыт: сегмент в секунду, чистильщик без порога грязи, надгробие живёт секунду.
 * На рабочих топиках те же ручки стоят на минутах и часах.
 */
const TOPIC_CONFIGS = {
  'segment.ms': '1000',
  'min.cleanable.dirty.ratio': '0.0',
  'min.compaction.lag.ms': '0',
  'max.compaction.lag.ms': '1000',
  'delete.retention.ms': '1000',
  'file.delete.delay.ms': '100',
};

/** Настройки, которые опыт показывает в протоколе значениями самого брокера. */
const SHOWN_CONFIGS = [
  'cleanup.policy',
  'segment.ms',
  'min.cleanable.dirty.ratio',
  'delete.retention.ms',
];

const ROLL_MS = 1_500;
const READ_LIMIT_MS = 20_000;
const COMPACT_LIMIT_MS = 120_000;
const COMPACT_STEP_MS = 2_000;
const TOMBSTONE_LIMIT_MS = 90_000;
const EXTRA_VERSIONS = 3;

/** Сообщение журнала глазами читателя: у надгробия значения нет. */
interface LogRecord {
  readonly key: string;
  readonly value: string | null;
  readonly offset: number;
}

/** Читатель топика: каждый проход перечитывает журнал с начала. */
interface Reader {
  readonly pass: () => Promise<LogRecord[]>;
}

/** Версия состояния прибора: содержимое второстепенно, важны ключ и номер версии. */
const stateValue = (key: string, version: number): string =>
  JSON.stringify({ deviceCode: key, health: version % 3 === 0 ? 'degraded' : 'online', version });

/** Череда версий одного ключа как сообщения для отправки. */
const versionMessages = (
  key: string,
  from: number,
  count: number,
): { key: string; value: string }[] =>
  Array.from({ length: count }, (_unused, index) => ({
    key,
    value: stateValue(key, from + index),
  }));

/** Значение для протокола: надгробие показывается словом, остальное как записано. */
const valueText = (record: LogRecord): string => record.value ?? 'надгробие (пустое значение)';

/** Сколько сообщений этого ключа сейчас в журнале. */
const countOf = (records: readonly LogRecord[], key: string): number =>
  records.filter((record) => record.key === key).length;

/** Настройки топика глазами брокера: в протокол идут реально применённые значения. */
const appliedConfigs = async (lab: Lab, topic: string): Promise<string> => {
  const described = await lab.admin.describeConfigs({
    includeSynonyms: false,
    resources: [{ type: ConfigResourceTypes.TOPIC, name: topic, configNames: [...SHOWN_CONFIGS] }],
  });
  const entries = described.resources[0]?.configEntries ?? [];

  return SHOWN_CONFIGS.map((name) => {
    const value = entries.find((entry) => entry.configName === name)?.configValue ?? 'нет';
    return `${name}=${value}`;
  }).join(', ');
};

/** Читатель топика: перед проходом перематывается в начало и ждёт последнего смещения журнала. */
const createReader = async (lab: Lab, topic: string): Promise<Reader> => {
  const consumer = await lab.consumer('reader');
  const seen = new Map<number, LogRecord>();

  await consumer.subscribe({ topic, fromBeginning: true });
  await consumer.run({
    eachMessage: ({ message }) => {
      const offset = Number(message.offset);
      seen.set(offset, {
        key: message.key === null ? '' : message.key.toString(),
        value: message.value === null ? null : message.value.toString(),
        offset,
      });
      return Promise.resolve();
    },
  });

  const pass = async (): Promise<LogRecord[]> => {
    const marks = (await lab.admin.fetchTopicOffsets(topic))[0];
    if (marks === undefined) throw new Error(`у топика ${topic} нет партиций`);
    const last = Number(marks.high) - 1;

    seen.clear();
    consumer.seek({ topic, partition: 0, offset: '0' });
    await lab.waitFor(`читатель дошёл до смещения ${last}`, () => seen.has(last), {
      limitMs: READ_LIMIT_MS,
    });

    return [...seen.values()].sort((left, right) => left.offset - right.offset);
  };

  return { pass };
};

/** Проверка ожидания: на ключ осталось ровно последнее записанное значение. */
const checkKept = (records: readonly LogRecord[], key: string, expected: string): void => {
  const kept = records.filter((record) => record.key === key);
  if (kept.length !== 1 || kept[0]?.value !== expected) {
    throw new Error(
      `после уплотнения по ключу ${key} ожидалось одно последнее значение, ` +
        `а в журнале сообщений ${kept.length}: ${kept.map(valueText).join(' | ')}`,
    );
  }
};

/** Опыт: компактируемый топик как хранилище состояния. */
export const compaction: Experiment = {
  name: 'compaction',
  title: 'компактируемый топик как хранилище состояния',
  run: async (lab) => {
    lab.step('топик с политикой очистки compact и агрессивными настройками сжатия');
    const topic = await lab.topic('state', {
      partitions: 1,
      cleanupPolicy: 'compact',
      configs: TOPIC_CONFIGS,
    });
    lab.note(`топик ${topic}, одна партиция`);
    lab.note(`брокер принял: ${await appliedConfigs(lab, topic)}`);

    lab.step('несколько версий состояния на один ключ');
    const producer = await lab.producer();
    const written = DEVICES.flatMap((device) => versionMessages(device.key, 1, device.versions));
    await producer.send({ topic, messages: written });
    lab.note(DEVICES.map((device) => `${device.key}: версий ${device.versions}`).join(', '));
    lab.note(`записано сообщений: ${written.length}`);

    lab.step('удаление ключа надгробием');
    await producer.send({ topic, messages: [{ key: DOOMED_KEY, value: null }] });
    lab.note(`${DOOMED_KEY}: записано сообщение с пустым значением`);

    lab.step('чтение журнала до уплотнения');
    const reader = await createReader(lab, topic);
    const before = await reader.pass();
    lab.observe(
      `читатель с начала журнала видит ${before.length} сообщений, старые версии в том числе`,
    );
    for (const device of DEVICES) {
      lab.note(`${device.key}: сообщений в журнале ${countOf(before, device.key)}`);
    }

    lab.step('закрытие сегмента: активный сегмент чистильщику недоступен');
    await lab.sleep(ROLL_MS);
    await producer.send({ topic, messages: [{ key: BOUNDARY_KEY, value: 'граница сегмента' }] });
    lab.note(`записан ключ ${BOUNDARY_KEY}, прошлый сегмент закрыт`);

    lab.step('ожидание работы чистильщика');
    const clock = lab.timer();
    let after = before;
    await lab.waitFor(
      'брокер уплотнил журнал',
      async () => {
        after = await reader.pass();
        return after.length <= DEVICES.length + 1;
      },
      { limitMs: COMPACT_LIMIT_MS, stepMs: COMPACT_STEP_MS },
    );
    lab.observe(`уплотнение случилось через ${clock.text()} после закрытия сегмента`);

    lab.step('что осталось в журнале');
    const marks = (await lab.admin.fetchTopicOffsets(topic))[0];
    lab.observe(`сообщений было ${before.length + 1}, осталось ${after.length}`);
    for (const record of after) {
      lab.note(`смещение ${record.offset}: ${record.key} = ${valueText(record)}`);
    }
    lab.observe(
      `границы журнала прежние: низшая ${marks?.low ?? '?'}, верхняя ${marks?.high ?? '?'}, ` +
        `первое читаемое сообщение на смещении ${after[0]?.offset ?? -1}`,
    );
    for (const device of DEVICES) {
      if (device.key === DOOMED_KEY) continue;
      checkKept(after, device.key, stateValue(device.key, device.versions));
    }
    const doomed = after.filter((record) => record.key === DOOMED_KEY);
    lab.observe(
      doomed.length === 1 && doomed[0]?.value === null
        ? `${DOOMED_KEY}: прежние версии ушли, осталось одно надгробие`
        : `${DOOMED_KEY}: сообщений в журнале ${doomed.length}: ${doomed.map(valueText).join(' | ')}`,
    );

    lab.step('второй проход чистильщика: навсегда ли остаётся надгробие');
    await producer.send({
      topic,
      messages: versionMessages(DEVICES[0].key, DEVICES[0].versions + 1, EXTRA_VERSIONS),
    });
    await lab.sleep(ROLL_MS);
    await producer.send({ topic, messages: [{ key: BOUNDARY_KEY, value: 'граница сегмента' }] });
    lab.note(
      `дописано версий ${EXTRA_VERSIONS} и снова закрыт сегмент, ` +
        `delete.retention.ms=${TOPIC_CONFIGS['delete.retention.ms']}`,
    );

    const second = lab.timer();
    let last = after;
    try {
      await lab.waitFor(
        'брокер убрал надгробие',
        async () => {
          last = await reader.pass();
          return countOf(last, DOOMED_KEY) === 0;
        },
        { limitMs: TOMBSTONE_LIMIT_MS, stepMs: COMPACT_STEP_MS },
      );
      lab.observe(
        `${DOOMED_KEY} исчез из журнала совсем через ${second.text()}: ` +
          'надгробие живёт delete.retention.ms и уходит следующим проходом',
      );
    } catch {
      lab.observe(
        `${DOOMED_KEY} за ${second.text()} из журнала не исчез: ` +
          'надгробие ещё на месте, следующего прохода чистильщика не случилось',
      );
    }
    lab.note(
      `в журнале осталось сообщений ${last.length}: ` +
        [...new Set(last.map((record) => record.key))]
          .map((key) => `${key} ${countOf(last, key)}`)
          .join(', '),
    );
    lab.note(
      'так же устроены рабочие fieldstream.device.state.v1 и fieldstream.collector.status.v1, ' +
        'но надгробий в них никто не пишет',
    );

    lab.conclude(
      `компактируемый топик хранит последнее значение на ключ, а не историю: ${before.length + 1} ` +
        `сообщений сжались до ${after.length}, и до уплотнения читатель видел все старые версии. ` +
        'Ключ уходит из такого топика только надгробием, которое кто-то должен написать',
    );
  },
};
