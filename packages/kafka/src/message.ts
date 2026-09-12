import { z } from 'zod';
import { KAFKA_HEADERS } from '@fieldstream/contracts';
import type { TopicSpec } from '@fieldstream/contracts';

/** Сообщение, готовое к отправке: тело уже прошло схему своего топика. */
export interface OutgoingMessage {
  readonly topic: string;
  readonly key: string;
  readonly value: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface EncodeOptions {
  readonly producer: string;
  readonly traceId: string;
}

const envelopeSchema = z.object({ schema: z.string().min(1), v: z.number().int().min(1) });

/**
 * Готовит сообщение для топика из манифеста. Писать разрешено только владельцу топика,
 * чужая публикация это ошибка. Схема проверяется здесь же, чтобы битые данные падали у автора.
 */
export const encodeMessage = <S extends z.ZodTypeAny>(
  spec: TopicSpec<S>,
  payload: z.infer<S>,
  options: EncodeOptions,
): OutgoingMessage => {
  if (spec.owner !== options.producer) {
    throw new Error(`в топик ${spec.name} пишет только ${spec.owner}, а не ${options.producer}`);
  }

  const parsed: unknown = spec.schema.parse(payload);
  const envelope = envelopeSchema.parse(parsed);

  return {
    topic: spec.name,
    key: spec.keyOf(payload),
    value: JSON.stringify(parsed),
    headers: {
      [KAFKA_HEADERS.schema]: envelope.schema,
      [KAFKA_HEADERS.schemaVersion]: String(envelope.v),
      [KAFKA_HEADERS.traceId]: options.traceId,
    },
  };
};
