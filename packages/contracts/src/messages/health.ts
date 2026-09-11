import { z } from 'zod';
import { isoTimestampSchema } from '../primitives.js';

export const healthStatusSchema = z.enum(['online', 'degraded', 'offline', 'unknown']);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

/**
 * Машинная причина статуса. Смысл в том, чтобы интерфейс показывал не только цвет,
 * но и повод, а тесты проверяли конкретный переход, а не «стало красным».
 */
export const healthReasonSchema = z.enum([
  'ok',
  'consecutive_errors',
  'stale',
  'no_data',
  'awaiting_success',
  'startup_grace',
  'polling_disabled',
  'children_offline',
]);
export type HealthReason = z.infer<typeof healthReasonSchema>;

export const healthNodeKindSchema = z.enum(['site', 'gateway', 'line', 'device']);
export type HealthNodeKind = z.infer<typeof healthNodeKindSchema>;

export interface HealthNode {
  kind: HealthNodeKind;
  code: string;
  label: string;
  status: HealthStatus;
  reason: HealthReason;
  since: string;
  lastOkAt: string | null;
  consecutiveErrors: number;
  children: HealthNode[];
}

export const healthNodeSchema: z.ZodType<HealthNode> = z.lazy(() =>
  z
    .object({
      kind: healthNodeKindSchema,
      code: z.string().min(1),
      label: z.string().min(1),
      status: healthStatusSchema,
      reason: healthReasonSchema,
      since: isoTimestampSchema,
      lastOkAt: isoTimestampSchema.nullable(),
      consecutiveErrors: z.number().int().min(0),
      children: z.array(healthNodeSchema),
    })
    .strict(),
);

/** Настройки автомата здоровья. Все пороги снаружи, время инжектируется через Clock. */
export interface HealthPolicy {
  /** Сколько ошибок подряд переводит прибор в offline. */
  offlineAfterErrors: number;
  /** Возраст последнего успеха, после которого данные считаются протухшими. */
  staleAfterMs: number;
  /** Окно после старта, в течение которого молчание не считается аварией. */
  startupGraceMs: number;
}

export const DEFAULT_HEALTH_POLICY: Readonly<HealthPolicy> = Object.freeze({
  offlineAfterErrors: 5,
  staleAfterMs: 300_000,
  startupGraceMs: 70_000,
});
