import { z } from 'zod';
import { isoTimestampSchema } from '../primitives.js';

/** Имя сценария стенда: kebab-case, совпадает с именем файла сценария. */
export const scenarioNameSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'ожидается имя в kebab-case, например dead-device');

export const scenarioStepKindSchema = z.enum([
  'inject',
  'clear',
  'simScenario',
  'baseline',
  'waitFor',
  'hold',
]);
export type ScenarioStepKind = z.infer<typeof scenarioStepKindSchema>;

export const scenarioStepStatusSchema = z.enum([
  'pending',
  'running',
  'passed',
  'failed',
  'skipped',
]);
export type ScenarioStepStatus = z.infer<typeof scenarioStepStatusSchema>;

/** Шаг прогона: заголовок человеческими словами и что увидели на нём. */
export const scenarioRunStepSchema = z
  .object({
    index: z.number().int().min(0),
    kind: scenarioStepKindSchema,
    title: z.string().min(1),
    status: scenarioStepStatusSchema,
    startedAt: isoTimestampSchema.nullable(),
    finishedAt: isoTimestampSchema.nullable(),
    detail: z.string().nullable(),
  })
  .strict();
export type ScenarioRunStep = z.infer<typeof scenarioRunStepSchema>;

/** Кто запустил прогон: кнопка интерфейса или проверки CI. */
export const scenarioRunSourceSchema = z.enum(['ui', 'ci']);
export type ScenarioRunSource = z.infer<typeof scenarioRunSourceSchema>;

export const scenarioRunStatusSchema = z.enum(['queued', 'running', 'passed', 'failed']);
export type ScenarioRunStatus = z.infer<typeof scenarioRunStatusSchema>;

/** Итоговые статусы прогона: после них ход больше не меняется. */
export const FINISHED_SCENARIO_RUN_STATUSES: readonly ScenarioRunStatus[] = Object.freeze([
  'passed',
  'failed',
]);

/** Прогон сценария стенда с ходом по шагам. */
export const scenarioRunSchema = z
  .object({
    id: z.string().uuid(),
    scenario: scenarioNameSchema,
    title: z.string().min(1),
    source: scenarioRunSourceSchema,
    requestedBy: z.string().min(1),
    status: scenarioRunStatusSchema,
    steps: z.array(scenarioRunStepSchema),
    error: z.string().nullable(),
    createdAt: isoTimestampSchema,
    startedAt: isoTimestampSchema.nullable(),
    finishedAt: isoTimestampSchema.nullable(),
  })
  .strict();
export type ScenarioRun = z.infer<typeof scenarioRunSchema>;

/** Сценарий в списке: описание, заголовки шагов и последний прогон. */
export const scenarioSummarySchema = z
  .object({
    name: scenarioNameSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    timeoutSec: z.number().int().min(1),
    steps: z.array(z.string().min(1)),
    lastRun: scenarioRunSchema.nullable(),
  })
  .strict();
export type ScenarioSummary = z.infer<typeof scenarioSummarySchema>;

/** Сценарии стенда и прогон, который идёт сейчас: на стенде он один. */
export const scenariosResponseSchema = z
  .object({
    serverTime: isoTimestampSchema,
    scenarios: z.array(scenarioSummarySchema),
    activeRun: scenarioRunSchema.nullable(),
  })
  .strict();
export type ScenariosResponse = z.infer<typeof scenariosResponseSchema>;

/** Запуск прогона. */
export const scenarioRunRequestSchema = z
  .object({ source: scenarioRunSourceSchema.default('ui') })
  .strict();
export type ScenarioRunRequest = z.infer<typeof scenarioRunRequestSchema>;
export type ScenarioRunRequestInput = z.input<typeof scenarioRunRequestSchema>;
