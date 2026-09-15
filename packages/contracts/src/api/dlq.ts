import { z } from 'zod';
import { isoTimestampSchema } from '../primitives.js';

const countSchema = z.number().int().min(0);

/** Номер строки базы: bigint едет строкой, в число JavaScript он целиком не влезает. */
export const dlqIdSchema = z.string().regex(/^[1-9]\d{0,17}$/, 'ожидается номер строки');

/** Сообщение очереди недоставленных так, как его показывает интерфейс. */
export const dlqMessageSchema = z
  .object({
    id: dlqIdSchema,
    sourceTopic: z.string().min(1),
    partition: countSchema,
    offset: z.string().regex(/^\d+$/),
    key: z.string().nullable(),
    errorClass: z.string().min(1),
    error: z.string(),
    attempts: z.number().int().min(1),
    firstSeen: isoTimestampSchema,
    lastSeen: isoTimestampSchema,
    resolvedAt: isoTimestampSchema.nullable(),
    finalRejected: z.boolean(),
    payloadPreview: z.string(),
    payloadBytes: countSchema,
  })
  .strict();
export type DlqMessage = z.infer<typeof dlqMessageSchema>;

/** Очередь листается курсором по номеру строки, новые сверху. */
export const dlqListQuerySchema = z
  .object({
    cursor: dlqIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type DlqListQuery = z.infer<typeof dlqListQuerySchema>;

export const dlqListResponseSchema = z
  .object({
    serverTime: isoTimestampSchema,
    items: z.array(dlqMessageSchema),
    nextCursor: dlqIdSchema.nullable(),
  })
  .strict();
export type DlqListResponse = z.infer<typeof dlqListResponseSchema>;

/** Запрос повторной подачи: сколько сообщений вернуть в исходные топики за один раз. */
export const dlqRedriveRequestSchema = z
  .object({ max: z.number().int().min(1).max(500).default(50) })
  .strict();
export type DlqRedriveRequest = z.infer<typeof dlqRedriveRequestSchema>;

export const dlqRedriveStatusSchema = z.enum(['queued', 'running', 'done', 'failed']);
export type DlqRedriveStatus = z.infer<typeof dlqRedriveStatusSchema>;

/** Судьба запроса повторной подачи: ждёт процессор, выполняется или завершён со счётами. */
export const dlqRedriveSchema = z
  .object({
    id: dlqIdSchema,
    status: dlqRedriveStatusSchema,
    maxMessages: z.number().int().min(1).max(500),
    redriven: countSchema,
    rejected: countSchema,
    error: z.string().nullable(),
    requestedBy: z.string().min(1),
    createdAt: isoTimestampSchema,
    startedAt: isoTimestampSchema.nullable(),
    finishedAt: isoTimestampSchema.nullable(),
  })
  .strict();
export type DlqRedrive = z.infer<typeof dlqRedriveSchema>;
