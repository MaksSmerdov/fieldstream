import { z } from 'zod';
import { isoTimestampSchema } from '../primitives.js';

export const bootStageStatusSchema = z.enum(['pending', 'running', 'done', 'failed']);
export type BootStageStatus = z.infer<typeof bootStageStatusSchema>;

/**
 * Стадия готовности стенда. Первый запуск занимает минуты, и загрузочная панель показывает,
 * чего именно ждать, вместо пустых экранов с нулями.
 */
export const bootStageViewSchema = z
  .object({
    stage: z.string().min(1),
    title: z.string().min(1),
    status: bootStageStatusSchema,
    progressPct: z.number().int().min(0).max(100),
    detail: z.string().nullable(),
  })
  .strict();
export type BootStageView = z.infer<typeof bootStageViewSchema>;

export const bootResponseSchema = z
  .object({
    ready: z.boolean(),
    stages: z.array(bootStageViewSchema),
    serverTime: isoTimestampSchema,
  })
  .strict();
export type BootResponse = z.infer<typeof bootResponseSchema>;
