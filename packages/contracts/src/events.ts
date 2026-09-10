import { z } from 'zod';
import {
  deviceCodeSchema,
  errorKindSchema,
  isoTimestampSchema,
  lineCodeSchema,
  traceIdSchema,
} from './primitives.js';
import { deviceModeSchema } from './device.js';
import { healthReasonSchema, healthStatusSchema } from './health.js';

/** Итог одного обращения к прибору. Отдельно от телеметрии, потому что пишется и при отказе. */
export const pollCycleSchema = z
  .object({
    schema: z.literal('poll.cycle'),
    v: z.literal(1),
    ts: isoTimestampSchema,
    lineCode: lineCodeSchema,
    deviceCode: deviceCodeSchema,
    ok: z.boolean(),
    errorKind: errorKindSchema.nullable(),
    durationMs: z.number().int().min(0),
    requestCount: z.number().int().min(0),
    planMode: z.enum(['merged', 'naive']),
    /** Фактически выбранная задержка: лестница backoff в интерфейсе рисуется по фактам. */
    backoff: z
      .object({
        baseMs: z.number().int().min(0),
        jitterMs: z.number().int(),
        chosenMs: z.number().int().min(0),
      })
      .strict()
      .optional(),
    breaker: z
      .object({
        state: z.enum(['closed', 'open', 'half_open']),
        nextProbeAt: isoTimestampSchema.nullable(),
      })
      .strict()
      .optional(),
    traceId: traceIdSchema,
  })
  .strict();
export type PollCycle = z.infer<typeof pollCycleSchema>;

/** Последнее известное состояние прибора. Едет в компактируемый топик. */
export const deviceStateSchema = z
  .object({
    schema: z.literal('device.state'),
    v: z.literal(1),
    deviceCode: deviceCodeSchema,
    status: healthStatusSchema,
    reason: healthReasonSchema,
    since: isoTimestampSchema,
    mode: deviceModeSchema,
    lastOkAt: isoTimestampSchema.nullable(),
    consecutiveErrors: z.number().int().min(0),
  })
  .strict();
export type DeviceState = z.infer<typeof deviceStateSchema>;

export const deviceEventKindSchema = z.enum([
  'mode_changed',
  'door_opened',
  'door_closed',
  'defrost_started',
  'defrost_finished',
  'went_offline',
  'came_online',
]);
export type DeviceEventKind = z.infer<typeof deviceEventKindSchema>;

export const deviceEventSchema = z
  .object({
    deviceCode: deviceCodeSchema,
    kind: deviceEventKindSchema,
    occurredAt: isoTimestampSchema,
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type DeviceEvent = z.infer<typeof deviceEventSchema>;
