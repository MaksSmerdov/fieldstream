import { setTimeout as delay } from 'node:timers/promises';
import { Kafka, logLevel } from 'kafkajs';
import type { Admin, Consumer, Producer } from 'kafkajs';
import type {
  Experiment,
  ExperimentName,
  Lab,
  LabTopicOptions,
  WaitOptions,
} from './experiment.js';
import { createReport, startTimer } from './report.js';
import type { Removed, Report } from './report.js';

/** Префикс учебных имён: боевые топики стенда под него не попадают. */
export const LAB_PREFIX = 'fieldstream.lab.';

/**
 * Брокер стенда, каким он виден с хоста: внутри сети compose это kafka:9092, наружу
 * опубликован порт 29092. Другой адрес задаётся переменной KAFKA_BROKERS.
 */
const DEFAULT_BROKERS = 'localhost:29092';

const TOPIC_LIMIT_MS = 15_000;
const WAIT_LIMIT_MS = 30_000;
const WAIT_STEP_MS = 200;
const GROUP_DROP_TRIES = 15;

/** Текст ошибки для протокола. */
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Адреса брокеров из KAFKA_BROKERS: список через запятую, пустое значение это умолчание. */
export const parseBrokers = (raw: string | undefined): string[] => {
  const value = raw === undefined || raw.trim() === '' ? DEFAULT_BROKERS : raw;

  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

/** Учебное имя топика или группы: fieldstream.lab.<опыт>.<суффикс>. */
export const labName = (experiment: ExperimentName, suffix: string): string => {
  const tail = suffix.trim();
  if (tail === '') throw new Error('суффикс учебного имени пустой');

  return `${LAB_PREFIX}${experiment}.${tail}`;
};

/** Учебное ли имя: всё, что лаборатория создаёт и удаляет, проходит эту проверку. */
export const isLabName = (name: string): boolean => name.startsWith(LAB_PREFIX);

/** Созданное за прогон: уходит в уборку, даже если опыт закончился отказом. */
interface Registry {
  readonly topics: Set<string>;
  readonly groups: Set<string>;
  readonly producers: Producer[];
  readonly consumers: Consumer[];
}

/** Настройки топика для брокера: политика очистки и всё, что задал опыт. */
const configEntriesOf = (options: LabTopicOptions): { name: string; value: string }[] =>
  Object.entries({
    ...(options.cleanupPolicy === undefined ? {} : { 'cleanup.policy': options.cleanupPolicy }),
    ...options.configs,
  }).map(([name, value]) => ({ name, value }));

/** Ожидание условия с пределом: понятный отказ вместо вечного висения. */
const waitFor = async (
  what: string,
  ready: () => boolean | Promise<boolean>,
  options: WaitOptions = {},
): Promise<void> => {
  const limitMs = options.limitMs ?? WAIT_LIMIT_MS;
  const stepMs = options.stepMs ?? WAIT_STEP_MS;
  const timer = startTimer();

  for (;;) {
    if (await ready()) return;
    if (timer.ms() >= limitMs) {
      throw new Error(`не дождались: ${what} (предел ${Math.round(limitMs / 1000)} с)`);
    }
    await delay(stepMs);
  }
};

/** Удаление учебных топиков с ожиданием: брокер убирает топик не мгновенно. */
const dropTopics = async (admin: Admin, names: readonly string[]): Promise<number> => {
  const topics = names.filter((name) => isLabName(name));
  if (topics.length === 0) return 0;

  await admin.deleteTopics({ topics: [...topics], timeout: TOPIC_LIMIT_MS });
  await waitFor('брокер убрал учебные топики', async () => {
    const left = await admin.listTopics();
    return topics.every((name) => !left.includes(name));
  });

  return topics.length;
};

/** Удаление учебных групп: группу с живым участником брокер не отдаёт, поэтому с повторами. */
const dropGroups = async (admin: Admin, names: readonly string[]): Promise<number> => {
  const groups = names.filter((name) => isLabName(name));
  if (groups.length === 0) return 0;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await admin.deleteGroups([...groups]);
      return groups.length;
    } catch (error) {
      if (attempt >= GROUP_DROP_TRIES) {
        throw new Error(`группы ${groups.join(', ')} не удалены: ${errorText(error)}`);
      }
      await delay(WAIT_STEP_MS);
    }
  }
};

/** Следы прошлого прогона: учебные топики и группы этого опыта убираются до начала опыта. */
const sweep = async (admin: Admin, prefix: string): Promise<Removed> => {
  const topics = (await admin.listTopics()).filter((name) => name.startsWith(prefix));
  const groups = (await admin.listGroups()).groups
    .map((group) => group.groupId)
    .filter((groupId) => groupId.startsWith(prefix));

  return { groups: await dropGroups(admin, groups), topics: await dropTopics(admin, topics) };
};

/** Уборка за опытом: сначала отключить клиентов, потом снять группы и топики. */
const tidy = async (admin: Admin, registry: Registry, report: Report): Promise<Removed> => {
  const clients = [...registry.consumers, ...registry.producers];
  await Promise.all(clients.map((client) => client.disconnect().catch(() => undefined)));

  try {
    const groups = await dropGroups(admin, [...registry.groups]);
    const topics = await dropTopics(admin, [...registry.topics]);
    return { topics, groups };
  } catch (error) {
    report.note(`убрать за опытом не вышло: ${errorText(error)}`);
    return { topics: 0, groups: 0 };
  }
};

/** Подключение администратора к брокеру: отказ объясняет, где взять адрес. */
const connectAdmin = async (admin: Admin, brokers: readonly string[]): Promise<void> => {
  try {
    await admin.connect();
    await admin.describeCluster();
  } catch (error) {
    throw new Error(
      `брокер ${brokers.join(', ')} не отвечает: ${errorText(error)}. ` +
        'Адрес задаётся переменной KAFKA_BROKERS, стенд публикует брокер на localhost:29092.',
    );
  }
};

/** Средства опыта поверх подключённого клиента: учебные имена, клиенты и протокол. */
const createLab = (params: {
  readonly experiment: Experiment;
  readonly brokers: readonly string[];
  readonly args: readonly string[];
  readonly kafka: Kafka;
  readonly admin: Admin;
  readonly registry: Registry;
  readonly report: Report;
}): Lab => {
  const { experiment, kafka, admin, registry, report } = params;

  const groupId = (suffix: string): string => {
    const name = labName(experiment.name, suffix);
    registry.groups.add(name);
    return name;
  };

  return {
    name: experiment.name,
    brokers: params.brokers,
    args: params.args,
    kafka,
    admin,
    groupId,
    topic: async (suffix, options = {}) => {
      const name = labName(experiment.name, suffix);
      const created = await admin.createTopics({
        waitForLeaders: true,
        timeout: TOPIC_LIMIT_MS,
        topics: [
          {
            topic: name,
            numPartitions: options.partitions ?? 1,
            replicationFactor: 1,
            configEntries: configEntriesOf(options),
          },
        ],
      });
      if (!created) throw new Error(`учебный топик ${name} уже есть у брокера`);

      registry.topics.add(name);
      return name;
    },
    producer: async (overrides = {}) => {
      const producer = kafka.producer({ allowAutoTopicCreation: false, ...overrides });
      registry.producers.push(producer);
      await producer.connect();
      return producer;
    },
    consumer: async (groupSuffix, overrides = {}) => {
      const consumer = kafka.consumer({
        sessionTimeout: 10_000,
        heartbeatInterval: 3_000,
        allowAutoTopicCreation: false,
        ...overrides,
        groupId: groupId(groupSuffix),
      });
      registry.consumers.push(consumer);
      await consumer.connect();
      return consumer;
    },
    waitFor,
    sleep: (ms) => delay(ms),
    timer: startTimer,
    step: report.step,
    observe: report.observe,
    note: report.note,
    conclude: report.conclude,
  };
};

/**
 * Прогон опыта: подключение к брокеру, уборка следов прошлого раза, сам опыт и уборка за собой.
 * Уборка идёт и при отказе, поэтому повторный запуск начинается с того же пустого места.
 */
export const runExperiment = async (
  experiment: Experiment,
  args: readonly string[],
): Promise<void> => {
  const brokers = parseBrokers(process.env.KAFKA_BROKERS);
  const report = createReport();
  const kafka = new Kafka({
    clientId: `kafka-lab-${experiment.name}`,
    brokers: [...brokers],
    logLevel: logLevel.NOTHING,
    retry: { retries: 3, initialRetryTime: 300, maxRetryTime: 3_000 },
  });
  const admin = kafka.admin();
  const registry: Registry = { topics: new Set(), groups: new Set(), producers: [], consumers: [] };
  const total = startTimer();

  report.head(experiment, brokers);
  await connectAdmin(admin, brokers);

  try {
    const stale = await sweep(admin, `${LAB_PREFIX}${experiment.name}.`);
    if (stale.topics + stale.groups > 0) {
      report.note(`следы прошлого прогона убраны: топиков ${stale.topics}, групп ${stale.groups}`);
    }
    await experiment.run(createLab({ experiment, brokers, args, kafka, admin, registry, report }));
  } finally {
    const removed = await tidy(admin, registry, report);
    await admin.disconnect().catch(() => undefined);
    report.foot(total.text(), removed);
  }
};
