import { z } from 'zod';

/**
 * Коды объектов это стабильные бизнес-идентификаторы, а не суррогатные id из базы.
 * Они уходят в ключ партиции Kafka, и пересоздание базы порядок внутри прибора не ломает.
 */
export const siteCodeSchema = z.string().regex(/^SITE-[A-Z]$/, 'ожидается вид SITE-A');
export const gatewayCodeSchema = z.string().regex(/^GW-\d{2}$/, 'ожидается вид GW-01');
export const lineCodeSchema = z.string().regex(/^L\d$/, 'ожидается вид L1');
export const deviceCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}-\d{3}$/, 'ожидается вид RC-101 или PM-201');

export type SiteCode = z.infer<typeof siteCodeSchema>;
export type GatewayCode = z.infer<typeof gatewayCodeSchema>;
export type LineCode = z.infer<typeof lineCodeSchema>;
export type DeviceCode = z.infer<typeof deviceCodeSchema>;

export const slaveIdSchema = z.number().int().min(1).max(247);
export const isoTimestampSchema = z.string().datetime({ offset: true });
export const traceIdSchema = z.string().min(8).max(64);

/** Качество значения. Протухшее и подставленное не выдаются за измеренное. */
export const qualitySchema = z.enum(['ok', 'stale', 'substituted', 'bad']);
export type Quality = z.infer<typeof qualitySchema>;

/** Причина неуспеха обращения к прибору. Классификация первична: от неё зависит поведение. */
export const errorKindSchema = z.enum(['timeout', 'crc', 'exception', 'stalled', 'disconnected']);
export type ErrorKind = z.infer<typeof errorKindSchema>;
