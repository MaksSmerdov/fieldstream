import { z } from 'zod';
import { lineStatusSchema } from '../messages/collector.js';
import { isoTimestampSchema } from '../primitives.js';
import { simFaultRequestSchema, simFaultSchema } from '../topology/sim.js';

/** Последние снимки линий от сборщика. */
export const labLinesResponseSchema = z
  .object({ serverTime: isoTimestampSchema, lines: z.array(lineStatusSchema) })
  .strict();
export type LabLinesResponse = z.infer<typeof labLinesResponseSchema>;

/** Действующие поломки стенда. */
export const labFaultsResponseSchema = z
  .object({ serverTime: isoTimestampSchema, faults: z.array(simFaultSchema) })
  .strict();
export type LabFaultsResponse = z.infer<typeof labFaultsResponseSchema>;

/** Поломка из панели хаоса: оттайка это разовое действие, а не поломка со сроком. */
export const labFaultRequestSchema = simFaultRequestSchema.refine(
  (request) => request.kind !== 'defrost',
  { message: 'оттайка запускается сценарием стенда, а не поломкой', path: ['kind'] },
);
export type LabFaultRequest = z.infer<typeof labFaultRequestSchema>;
export type LabFaultRequestInput = z.input<typeof labFaultRequestSchema>;
