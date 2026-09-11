import { CompressionTypes, Kafka, Partitioners, logLevel } from 'kafkajs';
import type { LogEntry, Producer, ProducerConfig, TopicMessages } from 'kafkajs';
import type { OutgoingMessage } from './message.js';

/** Минимальный логгер, в который перенаправляются сообщения kafkajs. */
export interface KafkaLog {
  readonly error: (fields: Record<string, unknown>, message: string) => void;
  readonly warn: (fields: Record<string, unknown>, message: string) => void;
  readonly info: (fields: Record<string, unknown>, message: string) => void;
  readonly debug: (fields: Record<string, unknown>, message: string) => void;
}

export interface KafkaClientOptions {
  readonly clientId: string;
  readonly brokers: readonly string[];
  readonly log: KafkaLog;
}

/**
 * Настройки продюсера: подтверждение от всех реплик, идемпотентность и до пяти запросов в полёте.
 * Идемпотентность сохраняет порядок внутри партиции при ретраях, без неё пришлось бы держать один запрос.
 * Ретраи бесконечные: при недоступном брокере отправка ждёт, а решение, что отбрасывать, принимает вызывающий.
 * Разделитель по murmur2 совместим с Java-клиентом: ключ прибора попадёт в ту же партицию из любого клиента.
 */
export const PRODUCER_CONFIG: ProducerConfig = Object.freeze({
  createPartitioner: Partitioners.DefaultPartitioner,
  idempotent: true,
  maxInFlightRequests: 5,
  allowAutoTopicCreation: false,
  retry: { retries: Number.MAX_SAFE_INTEGER, initialRetryTime: 100, maxRetryTime: 30_000 },
});

/** Логи kafkajs уходят в общий логгер сервиса, а не в консоль. */
const logCreator =
  (log: KafkaLog) =>
  () =>
  ({ level, namespace, log: entry }: LogEntry): void => {
    const { message, ...fields } = entry;
    const method =
      level <= logLevel.ERROR
        ? 'error'
        : level === logLevel.WARN
          ? 'warn'
          : level === logLevel.INFO
            ? 'info'
            : 'debug';
    log[method]({ ...fields, namespace }, message);
  };

/** Клиент Kafka с логами сервиса. */
export const createKafkaClient = (options: KafkaClientOptions): Kafka =>
  new Kafka({
    clientId: options.clientId,
    brokers: [...options.brokers],
    logLevel: logLevel.WARN,
    logCreator: logCreator(options.log),
  });

/**
 * Продюсер с настройками проекта. Переопределение нужно тому, кто сам не должен ждать брокер
 * бесконечно: потребитель с неотправленной пачкой иначе перестанет слать heartbeat.
 */
export const createProducer = (kafka: Kafka, overrides: Partial<ProducerConfig> = {}): Producer =>
  kafka.producer({ ...PRODUCER_CONFIG, ...overrides });

/** Сообщения, разложенные по топикам в исходном порядке: так их принимает sendBatch. */
export const groupByTopic = (messages: readonly OutgoingMessage[]): TopicMessages[] => {
  const byTopic = new Map<string, TopicMessages>();

  for (const message of messages) {
    const group = byTopic.get(message.topic) ?? { topic: message.topic, messages: [] };
    group.messages.push({
      key: message.key,
      value: message.value,
      headers: { ...message.headers },
    });
    byTopic.set(message.topic, group);
  }

  return [...byTopic.values()];
};

/**
 * Отправка пачки. Сжатие делает брокер по настройке топика, и выбран gzip: его kafkajs
 * распаковывает сам, а для LZ4 потребителям понадобился бы сторонний кодек.
 */
export const sendMessages = async (
  producer: Producer,
  messages: readonly OutgoingMessage[],
): Promise<void> => {
  if (messages.length === 0) return;
  await producer.sendBatch({
    acks: -1,
    compression: CompressionTypes.None,
    topicMessages: groupByTopic(messages),
  });
};
