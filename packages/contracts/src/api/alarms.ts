import { z } from 'zod';
import { deviceCodeSchema, isoTimestampSchema } from '../primitives.js';
import { severitySchema } from '../messages/alarms.js';
import { deviceModeSchema } from '../topology/device.js';

/** Состояние эпизода выводится из времени снятия, отдельной колонки для него нет. */
export const alarmStateFilterSchema = z.enum(['active', 'cleared', 'any']);
export type AlarmStateFilter = z.infer<typeof alarmStateFilterSchema>;

export const alarmListItemSchema = z
  .object({
    id: z.string().uuid(),
    deviceCode: deviceCodeSchema,
    deviceLabel: z.string().min(1),
    metricKey: z.string().min(1),
    mode: deviceModeSchema,
    severity: severitySchema,
    boundary: z.enum(['min', 'max']),
    value: z.number().nullable(),
    threshold: z.number().nullable(),
    occurredAt: isoTimestampSchema,
    clearedAt: isoTimestampSchema.nullable(),
    clearedValue: z.number().nullable(),
    ackedBy: z.string().nullable(),
    ackedAt: isoTimestampSchema.nullable(),
    active: z.boolean(),
  })
  .strict();
export type AlarmListItem = z.infer<typeof alarmListItemSchema>;

/** Лента листается курсором, а не смещением: страница не разъезжается от новых алармов. */
export const alarmsQuerySchema = z
  .object({
    state: alarmStateFilterSchema.default('any'),
    severity: severitySchema.optional(),
    device: deviceCodeSchema.optional(),
    from: isoTimestampSchema.optional(),
    to: isoTimestampSchema.optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type AlarmsQuery = z.infer<typeof alarmsQuerySchema>;

export const alarmsResponseSchema = z
  .object({
    items: z.array(alarmListItemSchema),
    nextCursor: z.string().nullable(),
    serverTime: isoTimestampSchema,
  })
  .strict();
export type AlarmsResponse = z.infer<typeof alarmsResponseSchema>;

/** Уставка прибора так, как её показывает и правит интерфейс. */
export const alarmRuleViewSchema = z
  .object({
    metricKey: z.string().min(1),
    mode: deviceModeSchema,
    minValue: z.number().nullable(),
    maxValue: z.number().nullable(),
    hysteresis: z.number().min(0),
    debounceCycles: z.number().int().min(1).max(60),
    severity: severitySchema,
    enabled: z.boolean(),
    updatedBy: z.string().nullable(),
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type AlarmRuleView = z.infer<typeof alarmRuleViewSchema>;

export const alarmRulesResponseSchema = z
  .object({ deviceCode: deviceCodeSchema, rules: z.array(alarmRuleViewSchema) })
  .strict();
export type AlarmRulesResponse = z.infer<typeof alarmRulesResponseSchema>;

/**
 * Правка уставки. Удаления нет намеренно: выключенная уставка остаётся в истории правок,
 * а у роли интерфейса на таблицу алармов нет права удалять что бы то ни было.
 */
export const alarmRuleUpdateSchema = z
  .object({
    metricKey: z.string().min(1),
    mode: deviceModeSchema,
    minValue: z.number().nullable(),
    maxValue: z.number().nullable(),
    hysteresis: z.number().min(0).max(1_000),
    debounceCycles: z.number().int().min(1).max(60),
    severity: severitySchema,
    enabled: z.boolean(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.minValue === null && rule.maxValue === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `уставка ${rule.metricKey}/${rule.mode}: нужна хотя бы одна граница`,
        path: ['maxValue'],
      });
    }
    if (rule.minValue !== null && rule.maxValue !== null && rule.minValue >= rule.maxValue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `уставка ${rule.metricKey}/${rule.mode}: нижняя граница должна быть меньше верхней`,
        path: ['minValue'],
      });
    }
  });
export type AlarmRuleUpdate = z.infer<typeof alarmRuleUpdateSchema>;

export const alarmRulesUpdateSchema = z
  .object({ rules: z.array(alarmRuleUpdateSchema).min(1).max(100) })
  .strict();
export type AlarmRulesUpdate = z.infer<typeof alarmRulesUpdateSchema>;

/** Что именно изменилось в уставке: это же попадает в историю правок. */
export const alarmRuleChangeSchema = z
  .object({
    metricKey: z.string().min(1),
    mode: deviceModeSchema,
    created: z.boolean(),
    changed: z.array(z.string()),
  })
  .strict();
export type AlarmRuleChange = z.infer<typeof alarmRuleChangeSchema>;

export const alarmRulesUpdateResponseSchema = z
  .object({
    deviceCode: deviceCodeSchema,
    changes: z.array(alarmRuleChangeSchema),
    rules: z.array(alarmRuleViewSchema),
  })
  .strict();
export type AlarmRulesUpdateResponse = z.infer<typeof alarmRulesUpdateResponseSchema>;

/** Значение поля уставки в журнале правок: числа, важность, признак включённости. */
export const alarmRuleFieldValueSchema = z.union([z.number(), z.string(), z.boolean(), z.null()]);

export const alarmRuleAuditFieldSchema = z
  .object({
    field: z.string().min(1),
    before: alarmRuleFieldValueSchema,
    after: alarmRuleFieldValueSchema,
  })
  .strict();
export type AlarmRuleAuditField = z.infer<typeof alarmRuleAuditFieldSchema>;

/**
 * Запись журнала правок. Кто и когда менял уставку, видно вместе с самими значениями:
 * «уставка изменена» без прежнего числа не позволяет понять, что именно произошло.
 */
export const alarmRuleAuditEntrySchema = z
  .object({
    id: z.string().min(1),
    metricKey: z.string().min(1),
    mode: deviceModeSchema,
    changedBy: z.string().min(1),
    changedAt: isoTimestampSchema,
    created: z.boolean(),
    fields: z.array(alarmRuleAuditFieldSchema),
  })
  .strict();
export type AlarmRuleAuditEntry = z.infer<typeof alarmRuleAuditEntrySchema>;

export const alarmRuleAuditResponseSchema = z
  .object({
    deviceCode: deviceCodeSchema,
    items: z.array(alarmRuleAuditEntrySchema),
    serverTime: isoTimestampSchema,
  })
  .strict();
export type AlarmRuleAuditResponse = z.infer<typeof alarmRuleAuditResponseSchema>;
