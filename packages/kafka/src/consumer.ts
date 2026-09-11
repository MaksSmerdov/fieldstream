import { ZodError } from 'zod';
import type { z } from 'zod';
import type { Consumer, ConsumerConfig, EachBatchPayload, IHeaders, Kafka } from 'kafkajs';
import { KAFKA_HEADERS } from '@fieldstream/contracts';
import type { TopicSpec } from '@fieldstream/contracts';

/**
 * Настройки потребителя: смещения подтверждает сам обработчик после записи в базу,
 * поэтому автоматический коммит в kafkajs выключается при запуске, а не здесь.
 */
export const CONSUMER_CONFIG: Omit<ConsumerConfig, 'groupId'> = Object.freeze({
  sessionTimeout: 30_000,
  heartbeatInterval: 3_000,
  allowAutoTopicCreation: false,
  retry: { retries: 5, initialRetryTime: 300, maxRetryTime: 30_000 },
});

/** Потребитель группы с настройками проекта. */
export const createConsumer = (kafka: Kafka, groupId: string): Consumer =>
  kafka.consumer({ ...CONSUMER_CONFIG, groupId });

/**
 * Подтверждение пачки по offset включительно. При autoCommit: false вызов
 * commitOffsetsIfNecessary() без аргументов в kafkajs не коммитит ничего, поэтому позиция
 * передаётся явно, и это следующее смещение для чтения, а не последнее прочитанное.
 */
export const commitThrough = async (payload: EachBatchPayload, offset: string): Promise<void> => {
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

/** Значение заголовка строкой. */
export const headerText = (headers: IHeaders | undefined, name: string): string | null => {
  const raw = headers?.[name];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === undefined) return null;
  return typeof first === 'string' ? first : first.toString('utf8');
};

/** Мажорная версия схемы из имени топика: fieldstream.telemetry.raw.v1 даёт 1. */
export const topicMajor = (name: string): number => {
  const version = /\.v(\d+)$/.exec(name)?.[1];
  return version === undefined ? 1 : Number(version);
};

export type DecodeFailure = 'empty' | 'invalid_json' | 'schema' | 'schema_major_mismatch';

export type Decoded<T> =
  | { readonly ok: true; readonly payload: T }
  | { readonly ok: false; readonly errorClass: DecodeFailure; readonly error: string };

/**
 * Разбор сообщения на входе: чужим данным не доверяем. Неудача разбора это повод
 * отправить сообщение в очередь недоставленных, а не остановить обработку партиции.
 */
export const decodeMessage = <S extends z.ZodTypeAny>(
  spec: TopicSpec<S>,
  value: Buffer | null,
  headers: IHeaders | undefined,
): Decoded<z.infer<S>> => {
  const version = headerText(headers, KAFKA_HEADERS.schemaVersion);
  if (version !== null && Number(version) > topicMajor(spec.name)) {
    return {
      ok: false,
      errorClass: 'schema_major_mismatch',
      error: `версия схемы ${version} новее той, что понимает потребитель`,
    };
  }
  if (value === null) return { ok: false, errorClass: 'empty', error: 'пустое значение' };

  let json: unknown;
  try {
    json = JSON.parse(value.toString('utf8'));
  } catch (error) {
    return {
      ok: false,
      errorClass: 'invalid_json',
      error: error instanceof Error ? error.message : 'значение не JSON',
    };
  }

  let payload: unknown;
  try {
    payload = spec.schema.parse(json);
  } catch (error) {
    const issues =
      error instanceof ZodError
        ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
        : String(error);
    return { ok: false, errorClass: 'schema', error: issues };
  }

  return { ok: true, payload: payload as z.infer<S> };
};
