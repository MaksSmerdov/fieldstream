import { Kafka, logLevel } from 'kafkajs';
import type { Broker, Docker } from './measure.js';
import { errorText } from './report.js';

/** Служба брокера в compose и путь к штатным утилитам внутри её образа. */
const KAFKA_SERVICE = 'kafka';
const KAFKA_TOOLS = '/opt/kafka/bin';

/** Адрес брокера изнутри сети compose: именно его видят утилиты, запущенные в контейнере. */
const INSIDE_BOOTSTRAP = 'localhost:9092';

/** Контейнер брокера, когда docker недоступен и спросить не у кого. */
const KAFKA_CONTAINER = 'fieldstream-kafka-1';

/** Имя контейнера брокера: у docker, а без него известное имя службы стенда. */
const containerOf = async (docker: Docker): Promise<string> => {
  try {
    return await docker.container(KAFKA_SERVICE);
  } catch {
    return KAFKA_CONTAINER;
  }
};

/**
 * Администратор брокера. Инструмент только читает: описывает группы и топики и снимает
 * смещения. Создавать, писать и удалять что-либо в боевых топиках стенда он не должен.
 */
export const createBroker = async (params: {
  readonly brokers: readonly string[];
  readonly docker: Docker;
  readonly note: (text: string) => void;
}): Promise<Broker> => {
  const kafka = new Kafka({
    clientId: 'fieldstream-bench',
    brokers: [...params.brokers],
    logLevel: logLevel.NOTHING,
    retry: { retries: 3, initialRetryTime: 300, maxRetryTime: 3_000 },
  });
  const admin = kafka.admin();

  try {
    await admin.connect();
    await admin.describeCluster();
  } catch (error) {
    await admin.disconnect().catch(() => undefined);
    throw new Error(
      `брокер ${params.brokers.join(', ')} не отвечает: ${errorText(error)}. ` +
        'Адрес задаётся переменной KAFKA_BROKERS, стенд публикует брокер на localhost:29092.',
    );
  }

  const container = await containerOf(params.docker);
  params.note(`брокер ${params.brokers.join(', ')} отвечает, утилиты берутся из ${container}`);

  return {
    admin,
    how: (tool, args) =>
      [
        'docker',
        'exec',
        container,
        `${KAFKA_TOOLS}/${tool}`,
        '--bootstrap-server',
        INSIDE_BOOTSTRAP,
        ...args,
      ].join(' '),
    close: () => admin.disconnect(),
  };
};
