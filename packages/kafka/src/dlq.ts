import { CompressionTypes } from 'kafkajs';
import type { IHeaders, Message, Producer } from 'kafkajs';
import { KAFKA_HEADERS, dlqIdSchema, isoTimestampSchema } from '@fieldstream/contracts';
import type { TopicSpec } from '@fieldstream/contracts';
import type { z } from 'zod';
import { headerText } from './consumer.js';

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

/**
 * Сколько раз сообщение уже падало, когда впервые и из какой строки очереди его подали повторно:
 * из заголовков прошлой повторной подачи.
 */
export interface DlqHistory {
  readonly attempts: number;
  readonly firstFailedAt: string | null;
  readonly redriveOf: string | null;
}

/** Больше попыток в заголовке не бывает: предел держит значение в колонке integer. */
export const MAX_HEADER_ATTEMPTS = 1_000;

const ATTEMPT_PATTERN = /^[1-9]\d{0,3}$/;
const LATEST_TIMESTAMP_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** Счёт попыток из заголовка: только целое 1..MAX_HEADER_ATTEMPTS, иначе попыток не было. */
const attemptsOf = (text: string | null): number =>
  text !== null && ATTEMPT_PATTERN.test(text) && Number(text) <= MAX_HEADER_ATTEMPTS
    ? Number(text)
    : 0;

/**
 * Момент первой неудачи из заголовка: строгий ISO 8601 со смещением в пределах от эпохи Unix
 * до 9999 года, приведённый к UTC. Остальное база не примет, поэтому оно считается отсутствующим.
 */
const firstFailedAtOf = (text: string | null): string | null => {
  if (text === null || !isoTimestampSchema.safeParse(text).success) return null;
  const ms = Date.parse(text);

  return Number.isFinite(ms) && ms >= 0 && ms <= LATEST_TIMESTAMP_MS
    ? new Date(ms).toISOString()
    : null;
};

/**
 * История неудач входящего сообщения. Нет заголовков или они испорчены: сообщение падает впервые.
 * Кривой заголовок не должен ронять запись очереди недоставленных и останавливать партицию.
 */
export const readDlqHistory = (headers: IHeaders | undefined): DlqHistory => {
  const redriveOf = headerText(headers, KAFKA_HEADERS.dlqRedriveOf);

  return {
    attempts: attemptsOf(headerText(headers, KAFKA_HEADERS.dlqAttempt)),
    firstFailedAt: firstFailedAtOf(headerText(headers, KAFKA_HEADERS.dlqFirstFailedAt)),
    redriveOf: redriveOf !== null && dlqIdSchema.safeParse(redriveOf).success ? redriveOf : null,
  };
};

/** Часть манифеста, по которой решается, куда и кому разрешена повторная подача. */
export type RedriveTarget = Pick<TopicSpec<z.ZodTypeAny>, 'name' | 'redriver'>;

/** Сообщение из очереди недоставленных в том виде, в каком его сохранила база. */
export interface RedriveSource {
  readonly id: string;
  readonly key: Buffer | null;
  readonly value: Buffer | null;
  readonly headers: Readonly<Record<string, Buffer | string>>;
  readonly attempts: number;
  readonly firstFailedAt: string;
}

/**
 * Сообщение повторной подачи: исходный топик, исходный ключ и исходные байты, поэтому оно ляжет
 * в ту же партицию. Заголовки несут, сколько раз оно уже падало и когда впервые, чтобы следующая
 * неудача продолжила счёт, а не начала его заново, и номер строки очереди: дошедшая до процессора
 * копия закрывает свою строку, даже если отметку повторной подачи откатил сбой.
 * Подавать разрешено только объявленному в манифесте.
 */
export const toRedriveMessage = (
  spec: RedriveTarget,
  source: RedriveSource,
  producer: string,
): RawOutgoingMessage => {
  if (spec.redriver !== producer) {
    throw new Error(
      spec.redriver === undefined
        ? `в топик ${spec.name} повторная подача не разрешена`
        : `в топик ${spec.name} повторно подаёт только ${spec.redriver}, а не ${producer}`,
    );
  }

  return {
    topic: spec.name,
    key: source.key,
    value: source.value,
    headers: {
      ...source.headers,
      [KAFKA_HEADERS.dlqAttempt]: String(source.attempts),
      [KAFKA_HEADERS.dlqFirstFailedAt]: source.firstFailedAt,
      [KAFKA_HEADERS.dlqRedriveOf]: source.id,
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
