import { z } from 'zod';
import { isoTimestampSchema, lineCodeSchema } from '../primitives.js';
import { commandArgsSchema, commandKindSchema } from '../messages/commands.js';

/** Запрос оператора: что и на какой линии сделать. Площадку шлюз находит сам по линии. */
export const commandRequestSchema = z
  .object({
    lineCode: lineCodeSchema,
    kind: commandKindSchema,
    args: commandArgsSchema.default({}),
  })
  .strict();
export type CommandRequest = z.infer<typeof commandRequestSchema>;

/** Команда принята, но ещё не применена: она лежит в очереди исходящих. */
export const commandAcceptedSchema = z
  .object({
    commandId: z.string().uuid(),
    lineCode: lineCodeSchema,
    kind: commandKindSchema,
    issuedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict();
export type CommandAccepted = z.infer<typeof commandAcceptedSchema>;

export const commandStageSchema = z.enum(['queued', 'sent', 'applied', 'rejected', 'expired']);

export const commandProgressSchema = z
  .object({
    commandId: z.string().uuid(),
    stage: commandStageSchema,
    issuedAt: isoTimestampSchema,
    publishedAt: isoTimestampSchema.nullable(),
    appliedAt: isoTimestampSchema.nullable(),
    attempts: z.number().int().min(0),
    detail: z.string().nullable(),
  })
  .strict();
export type CommandProgressResponse = z.infer<typeof commandProgressSchema>;
