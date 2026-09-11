import { CompressionTypes } from 'kafkajs';
import type { IHeaders, Message, Producer } from 'kafkajs';
import { KAFKA_HEADERS } from '@fieldstream/contracts';
import type { TopicSpec } from '@fieldstream/contracts';
import type { z } from 'zod';

/** Исходное сообщение, которое не удалось обработать. */
export interface DlqOrigin {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly timestamp: string;
  readonly key: Buffer | null;
  readonly value: Buffer | null;
  readonly headers: IHeaders | undefined;
}

/** Почему сообщение не обработано и кем. */
export interface DlqFailure {
  readonly errorClass: string;
  readonly error: string;
  readonly consumerGroup: string;
  readonly attempt: number;
  readonly firstFailedAt: string;
}

/** Сообщение с сырыми байтами: для очереди недоставленных JSON-обёртка не годится. */
export interface RawOutgoingMessage {
  readonly topic: string;
  readonly key: Buffer | null;
  readonly value: Buffer | null;
  readonly headers: Readonly<Record<string, Buffer | string>>;
}

/** Заголовки исходного сообщения без повторов значения. */
const flatHeaders = (headers: IHeaders | undefined): Record<string, Buffer | string> => {
  const flat: Record<string, Buffer | string> = {};
  for (const [name, raw] of Object.entries(headers ?? {})) {
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (first !== undefined) flat[name] = first;
  }
  return flat;
};

/**
 * Сообщение для очереди недоставленных: исходные байты без попытки разбора, исходный ключ,
 * а вся диагностика в заголовках. Ключ сохраняется, чтобы повторная подача вернула сообщение
 * в ту же партицию исходного топика и не нарушила порядок внутри прибора.
 */
export const toDlqMessage = <S extends z.ZodTypeAny>(
  spec: TopicSpec<S>,
  origin: DlqOrigin,
  failure: DlqFailure,
  producer: string,
): RawOutgoingMessage => {
  if (spec.owner !== producer) {
    throw new Error(`в топик ${spec.name} пишет только ${spec.owner}, а не ${producer}`);
  }

  return {
    topic: spec.name,
    key: origin.key,
    value: origin.value,
    headers: {
      ...flatHeaders(origin.headers),
      [KAFKA_HEADERS.dlqOriginTopic]: origin.topic,
      [KAFKA_HEADERS.dlqOriginPartition]: String(origin.partition),
      [KAFKA_HEADERS.dlqOriginOffset]: origin.offset,
      [KAFKA_HEADERS.dlqOriginTimestamp]: origin.timestamp,
      [KAFKA_HEADERS.dlqErrorClass]: failure.errorClass,
      [KAFKA_HEADERS.dlqError]: failure.error.slice(0, 1_000),
      [KAFKA_HEADERS.dlqAttempt]: String(failure.attempt),
      [KAFKA_HEADERS.dlqFirstFailedAt]: failure.firstFailedAt,
      [KAFKA_HEADERS.dlqConsumerGroup]: failure.consumerGroup,
    },
  };
};

/** Отправка сообщений с сырыми байтами, с тем же подтверждением от всех реплик. */
export const sendRawMessages = async (
  producer: Producer,
  messages: readonly RawOutgoingMessage[],
): Promise<void> => {
  if (messages.length === 0) return;

  const byTopic = new Map<string, Message[]>();
  for (const message of messages) {
    const list = byTopic.get(message.topic) ?? [];
    list.push({ key: message.key, value: message.value, headers: { ...message.headers } });
    byTopic.set(message.topic, list);
  }

  await producer.sendBatch({
    acks: -1,
    compression: CompressionTypes.None,
    topicMessages: [...byTopic].map(([topic, list]) => ({ topic, messages: list })),
  });
};
