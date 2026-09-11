import { z } from 'zod';
import { deviceCodeSchema, isoTimestampSchema, traceIdSchema } from '../primitives.js';
import { deviceModeSchema } from '../topology/device.js';

export const severitySchema = z.enum(['info', 'warning', 'critical']);
export type Severity = z.infer<typeof severitySchema>;

/**
 * Уставка привязана к режиму объекта. Во время оттайки температура законно растёт
 * на несколько градусов, и без режима аларм по верхней границе срабатывал бы
 * на всём складе каждые сорок минут.
 */
export const alarmRuleSchema = z
  .object({
    deviceCode: deviceCodeSchema,
    metricKey: z.string().min(1),
    mode: deviceModeSchema,
    minValue: z.number().nullable(),
    maxValue: z.number().nullable(),
    /** Зона возврата: значение должно уйти за границу на hysteresis, чтобы аларм снялся. */
    hysteresis: z.number().min(0).default(0),
    /** Сколько подряд циклов нарушения нужно, чтобы аларм поднялся. */
    debounceCycles: z.number().int().min(1).max(60).default(1),
    severity: severitySchema.default('warning'),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.minValue !== null && rule.maxValue !== null && rule.minValue >= rule.maxValue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `уставка ${rule.deviceCode}/${rule.metricKey}/${rule.mode}: minValue должен быть меньше maxValue`,
        path: ['minValue'],
      });
    }
    if (rule.minValue === null && rule.maxValue === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `уставка ${rule.deviceCode}/${rule.metricKey}/${rule.mode}: нужна хотя бы одна граница`,
        path: ['maxValue'],
      });
    }
  });
export type AlarmRule = z.infer<typeof alarmRuleSchema>;

export const alarmStateSchema = z.enum(['raised', 'cleared']);
export type AlarmState = z.infer<typeof alarmStateSchema>;

export const alarmEventSchema = z
  .object({
    schema: z.literal('alarm.event'),
    v: z.literal(1),
    alarmId: z.string().uuid(),
    /** Ключ дедупликации: уникальный индекс в БД гасит повтор при пересчёте батча. */
    dedupeKey: z.string().min(1),
    deviceCode: deviceCodeSchema,
    metricKey: z.string().min(1),
    mode: deviceModeSchema,
    state: alarmStateSchema,
    severity: severitySchema,
    value: z.number().nullable(),
    threshold: z.number().nullable(),
    boundary: z.enum(['min', 'max']),
    occurredAt: isoTimestampSchema,
    traceId: traceIdSchema,
  })
  .strict();
export type AlarmEvent = z.infer<typeof alarmEventSchema>;
