import { z } from 'zod';
import {
  deviceCodeSchema,
  gatewayCodeSchema,
  isoTimestampSchema,
  lineCodeSchema,
  qualitySchema,
  siteCodeSchema,
  slaveIdSchema,
  traceIdSchema,
} from './primitives.js';
import { registerTypeSchema } from './device.js';

/**
 * Прочитанный блок регистров как он пришёл с линии.
 * В топик едут именно сырые слова, а не готовые значения: только это делает
 * реплей осмысленным, потому что декодер можно исправить и прогнать заново.
 */
export const rawBlockSchema = z
  .object({
    registerType: registerTypeSchema,
    startAddress: z.number().int().min(0).max(65535),
    words: z.array(z.number().int().min(0).max(65535)).min(1).max(125),
  })
  .strict();
export type RawBlock = z.infer<typeof rawBlockSchema>;

export const telemetryRawSchema = z
  .object({
    schema: z.literal('telemetry.raw'),
    v: z.literal(1),
    ts: isoTimestampSchema,
    siteCode: siteCodeSchema,
    gatewayCode: gatewayCodeSchema,
    lineCode: lineCodeSchema,
    deviceCode: deviceCodeSchema,
    slaveId: slaveIdSchema,
    profileKey: z.string().min(1),
    profileVersion: z.number().int().min(1),
    blocks: z.array(rawBlockSchema).min(1),
    cycleMs: z.number().int().min(0),
    traceId: traceIdSchema,
  })
  .strict();
export type TelemetryRaw = z.infer<typeof telemetryRawSchema>;

export const telemetryReadingSchema = z
  .object({
    schema: z.literal('telemetry.reading'),
    v: z.literal(1),
    deviceCode: deviceCodeSchema,
    ts: isoTimestampSchema,
    mode: z.string().min(1),
    metrics: z.record(z.string(), z.number().nullable()),
    quality: qualitySchema,
    sourceOffset: z.object({ partition: z.number().int().min(0), offset: z.string() }).strict(),
    traceId: traceIdSchema,
  })
  .strict();
export type TelemetryReading = z.infer<typeof telemetryReadingSchema>;
