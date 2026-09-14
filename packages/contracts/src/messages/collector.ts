import { z } from 'zod';
import { deviceCodeSchema, isoTimestampSchema, lineCodeSchema } from '../primitives.js';
import { planModeSchema } from '../topology/device.js';

/** Состояние размыкателя прибора. */
export const breakerStateSchema = z.enum(['closed', 'open', 'half_open']);
export type BreakerState = z.infer<typeof breakerStateSchema>;

const countSchema = z.number().int().min(0);
const percentileSchema = z.number().min(0).nullable();

/** Попытка переподключения к порту линии с выбранной задержкой. */
export const reconnectStepSchema = z
  .object({
    attempt: countSchema,
    at: isoTimestampSchema,
    baseMs: countSchema,
    jitterMs: z.number().int(),
    chosenMs: countSchema,
  })
  .strict();
export type ReconnectStep = z.infer<typeof reconnectStepSchema>;

/** Время ответа по скользящему окну запросов линии. */
export const latencyWindowSchema = z
  .object({
    bucketsMs: z.array(z.number().int().min(1)).min(1),
    counts: z.array(countSchema),
    samples: countSchema,
    timeouts: countSchema,
    p50Ms: percentileSchema,
    p95Ms: percentileSchema,
    p99Ms: percentileSchema,
    suggestedTimeoutMs: countSchema.nullable(),
  })
  .strict()
  .refine((window) => window.counts.length === window.bucketsMs.length + 1, {
    message: 'корзин должно быть на одну больше границ: последняя для ответов сверх границ',
    path: ['counts'],
  });
export type LatencyWindow = z.infer<typeof latencyWindowSchema>;

/** Снимок линии для приборной панели: сборщик за NAT, поэтому его состояние едет топиком. */
export const lineStatusSchema = z
  .object({
    schema: z.literal('line.status'),
    v: z.literal(1),
    ts: isoTimestampSchema,
    lineCode: lineCodeSchema,
    running: z.boolean(),
    connected: z.boolean(),
    planMode: planModeSchema,
    pollIntervalMs: countSchema,
    requestTimeoutMs: countSchema,
    hardTimeoutMs: countSchema,
    watchdog: z
      .object({
        limitMs: countSchema,
        cycleStartedAt: isoTimestampSchema.nullable(),
        trips: countSchema,
      })
      .strict(),
    lastCycle: z
      .object({
        at: isoTimestampSchema,
        outcome: z.enum(['polled', 'idle', 'disconnected', 'watchdog']),
        durationMs: countSchema,
        polled: countSchema,
        failed: countSchema,
      })
      .strict()
      .nullable(),
    reconnects: z.array(reconnectStepSchema).max(12),
    devices: z.array(
      z
        .object({
          deviceCode: deviceCodeSchema,
          slaveId: z.number().int().min(1).max(247),
          breaker: z
            .object({
              state: breakerStateSchema,
              failures: countSchema,
              probeDelayMs: countSchema,
              nextProbeAt: isoTimestampSchema.nullable(),
            })
            .strict(),
        })
        .strict(),
    ),
    latency: latencyWindowSchema,
  })
  .strict();
export type LineStatus = z.infer<typeof lineStatusSchema>;
