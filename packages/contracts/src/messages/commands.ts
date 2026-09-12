import { z } from 'zod';
import {
  isoTimestampSchema,
  lineCodeSchema,
  siteCodeSchema,
  traceIdSchema,
} from '../primitives.js';
import { planModeSchema } from '../topology/device.js';

/** Команды линии. Все четыре меняют режим опроса и в регистры не пишут, поэтому повтор безвреден. */
export const commandKindSchema = z.enum([
  'line.enable',
  'line.disable',
  'line.set_poll_interval',
  'line.plan_mode',
]);
export type CommandKind = z.infer<typeof commandKindSchema>;

export const commandArgsSchema = z
  .object({
    pollIntervalMs: z.number().int().min(1_000).max(600_000).optional(),
    planMode: planModeSchema.optional(),
  })
  .strict();
export type CommandArgs = z.infer<typeof commandArgsSchema>;

/** Операторская команда. Ключ топика это площадка, чужие команды сборщик пропускает. */
export const deviceCommandSchema = z
  .object({
    schema: z.literal('device.command'),
    v: z.literal(1),
    commandId: z.string().uuid(),
    issuedBy: z.string().min(1),
    siteCode: siteCodeSchema,
    lineCode: lineCodeSchema,
    kind: commandKindSchema,
    args: commandArgsSchema,
    issuedAt: isoTimestampSchema,
    /** Команда с истёкшим сроком не применяется: лучше отказ, чем действие невпопад. */
    expiresAt: isoTimestampSchema,
    traceId: traceIdSchema,
  })
  .strict()
  .superRefine((command, ctx) => {
    if (command.kind === 'line.set_poll_interval' && command.args.pollIntervalMs === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'команде смены такта нужен pollIntervalMs',
        path: ['args', 'pollIntervalMs'],
      });
    }
    if (command.kind === 'line.plan_mode' && command.args.planMode === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'команде смены плана чтения нужен planMode',
        path: ['args', 'planMode'],
      });
    }
  });
export type DeviceCommand = z.infer<typeof deviceCommandSchema>;

export const commandStatusSchema = z.enum(['applied', 'rejected', 'expired']);
export type CommandStatus = z.infer<typeof commandStatusSchema>;

/** Ответ исполнителя. Сборщик про базу не знает, факт применения едет обратно через брокер. */
export const commandResultSchema = z
  .object({
    schema: z.literal('device.command.result'),
    v: z.literal(1),
    commandId: z.string().uuid(),
    siteCode: siteCodeSchema,
    lineCode: lineCodeSchema,
    kind: commandKindSchema,
    status: commandStatusSchema,
    detail: z.string().min(1),
    appliedAt: isoTimestampSchema,
    traceId: traceIdSchema,
  })
  .strict();
export type CommandResult = z.infer<typeof commandResultSchema>;
