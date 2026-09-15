import { z } from 'zod';
import {
  deviceCodeSchema,
  isoTimestampSchema,
  lineCodeSchema,
  slaveIdSchema,
} from '../primitives.js';

/**
 * Поломки, которые умеет вносить стенд. Транспортные (silent, crc, stall, exception) бьют
 * по обмену на линии, offline роняет порт шлюза, остальные меняют физику или показания.
 */
export const simFaultKindSchema = z.enum([
  'silent',
  'crc',
  'stall',
  'exception',
  'offline',
  'power_dip',
  'offscale',
  'door_stuck',
  'defrost',
]);
export type SimFaultKind = z.infer<typeof simFaultKindSchema>;

export const simTargetKindSchema = z.enum(['line', 'device']);
export type SimTargetKind = z.infer<typeof simTargetKindSchema>;

const LINE_ONLY_KINDS: readonly SimFaultKind[] = ['offline', 'power_dip'];
const DEVICE_ONLY_KINDS: readonly SimFaultKind[] = ['offscale', 'door_stuck', 'defrost'];

export const simFaultRequestSchema = z
  .object({
    targetKind: simTargetKindSchema,
    targetId: z.string().min(1),
    kind: simFaultKindSchema,
    ttlSec: z.number().int().min(1).max(86_400).default(300),
    /** Код исключения Modbus при kind = exception: 4 отказ прибора, 11 шлюз не дождался ответа. */
    exceptionCode: z.number().int().min(1).max(255).default(4),
    /** Параметр, который уходит за шкалу при kind = offscale. По умолчанию первый измеряемый. */
    paramKey: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.targetKind === 'device' && LINE_ONLY_KINDS.includes(request.kind)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `поломка "${request.kind}" вносится только на линию`,
        path: ['kind'],
      });
    }
    if (request.targetKind === 'line' && DEVICE_ONLY_KINDS.includes(request.kind)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `поломка "${request.kind}" вносится только на прибор`,
        path: ['kind'],
      });
    }

    const codeSchema = request.targetKind === 'line' ? lineCodeSchema : deviceCodeSchema;
    if (!codeSchema.safeParse(request.targetId).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          request.targetKind === 'line'
            ? 'ожидается код линии вида L1'
            : 'ожидается код прибора вида RC-101',
        path: ['targetId'],
      });
    }

    if (request.paramKey !== undefined && request.kind !== 'offscale') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'paramKey задаётся только для поломки "offscale"',
        path: ['paramKey'],
      });
    }
  });
export type SimFaultRequest = z.infer<typeof simFaultRequestSchema>;
export type SimFaultRequestInput = z.input<typeof simFaultRequestSchema>;

/** Действующая поломка в ответе стенда. */
export const simFaultSchema = z
  .object({
    id: z.string().min(1),
    targetKind: simTargetKindSchema,
    targetId: z.string().min(1),
    kind: simFaultKindSchema,
    since: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
    exceptionCode: z.number().int().nullable(),
    paramKey: z.string().nullable(),
  })
  .strict();
export type SimFault = z.infer<typeof simFaultSchema>;

/** Выборочное снятие поломок: без фильтров снимаются все. */
export const simClearFaultsQuerySchema = z
  .object({
    targetId: z.union([lineCodeSchema, deviceCodeSchema]).optional(),
    kind: simFaultKindSchema.optional(),
  })
  .strict();
export type SimClearFaultsQuery = z.infer<typeof simClearFaultsQuerySchema>;

export const simClearFaultsResultSchema = z.object({ removed: z.number().int().min(0) }).strict();
export type SimClearFaultsResult = z.infer<typeof simClearFaultsResultSchema>;

export const simScenarioNameSchema = z.enum([
  'night-defrost',
  'power-dip',
  'door-left-open',
  'line-blackout',
]);
export type SimScenarioName = z.infer<typeof simScenarioNameSchema>;

/** Итог одной поломки сценария симулятора: поломка, разовое действие или отказ стенда. */
export const simScenarioResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('fault'), fault: simFaultSchema }).strict(),
  z
    .object({
      outcome: z.literal('action'),
      action: z.literal('defrost_started'),
      deviceCode: deviceCodeSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('rejected'),
      status: z.number().int(),
      message: z.string(),
    })
    .strict(),
]);
export type SimScenarioResult = z.infer<typeof simScenarioResultSchema>;

/** Ответ стенда на запуск сценария: по итогу на каждую поломку сценария. */
export const simScenarioResponseSchema = z
  .object({ scenario: simScenarioNameSchema, results: z.array(simScenarioResultSchema) })
  .strict();
export type SimScenarioResponse = z.infer<typeof simScenarioResponseSchema>;

/** Ускорение времени стенда: на 60x сутки проживаются за 24 минуты. */
export const simSpeedRequestSchema = z.object({ factor: z.number().min(1).max(60) }).strict();
export type SimSpeedRequest = z.infer<typeof simSpeedRequestSchema>;

export const simValueSchema = z.union([
  z.number(),
  z.string(),
  z.record(z.string(), z.boolean()),
  z.null(),
]);

export const simLineSnapshotSchema = z
  .object({
    lineCode: lineCodeSchema,
    port: z.number().int(),
    baud: z.number().int(),
    online: z.boolean(),
    requests: z.number().int().min(0),
    lastRequestAt: isoTimestampSchema.nullable(),
  })
  .strict();
export type SimLineSnapshot = z.infer<typeof simLineSnapshotSchema>;

export const simDeviceSnapshotSchema = z
  .object({
    deviceCode: deviceCodeSchema,
    lineCode: lineCodeSchema,
    slaveId: slaveIdSchema,
    profileKey: z.string().min(1),
    values: z.record(z.string(), simValueSchema),
    faults: z.array(simFaultKindSchema),
  })
  .strict();
export type SimDeviceSnapshot = z.infer<typeof simDeviceSnapshotSchema>;

/** Эталон внутреннего состояния стенда: с ним сверяются сквозные тесты. */
export const simStateSchema = z
  .object({
    simTime: isoTimestampSchema,
    speed: z.number(),
    seed: z.string(),
    lines: z.array(simLineSnapshotSchema),
    devices: z.array(simDeviceSnapshotSchema),
    faults: z.array(simFaultSchema),
  })
  .strict();
export type SimState = z.infer<typeof simStateSchema>;
