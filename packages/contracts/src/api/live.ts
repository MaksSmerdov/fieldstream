import { z } from 'zod';
import { deviceCodeSchema, isoTimestampSchema, qualitySchema } from '../primitives.js';
import { healthReasonSchema, healthStatusSchema } from '../messages/health.js';
import { alarmStateSchema, severitySchema } from '../messages/alarms.js';
import { deviceModeSchema } from '../topology/device.js';

/**
 * Кадры живого канала. Одна схема на сервере и на клиенте: браузер разбирает ровно то,
 * что шлюз обещал, а не то, что он думает про формат.
 */
export const liveHelloSchema = z
  .object({
    serverTime: isoTimestampSchema,
    /** Эпоха шлюза. Сменилась, значит шлюз перезапустился и прежние номера событий ничего не значат. */
    epoch: z.number().int().min(0),
    pingMs: z.number().int().min(1_000),
  })
  .strict();
export type LiveHello = z.infer<typeof liveHelloSchema>;

export const liveResyncReasonSchema = z.enum(['unknown_epoch', 'too_old']);

export const liveResyncSchema = z
  .object({
    reason: liveResyncReasonSchema.nullable(),
    serverTime: isoTimestampSchema,
  })
  .strict();
export type LiveResync = z.infer<typeof liveResyncSchema>;

export const livePingSchema = z.object({ at: isoTimestampSchema }).strict();

/** Показания прибора. Дросселируются на сервере до одного кадра в секунду на прибор. */
export const liveReadingSchema = z
  .object({
    deviceCode: deviceCodeSchema,
    ts: isoTimestampSchema,
    mode: deviceModeSchema,
    quality: qualitySchema,
    metrics: z.record(z.string(), z.number().nullable()),
  })
  .strict();
export type LiveReading = z.infer<typeof liveReadingSchema>;

export const liveDeviceStateSchema = z
  .object({
    deviceCode: deviceCodeSchema,
    status: healthStatusSchema,
    reason: healthReasonSchema,
    mode: deviceModeSchema,
    since: isoTimestampSchema,
    lastOkAt: isoTimestampSchema.nullable(),
    consecutiveErrors: z.number().int().min(0),
  })
  .strict();
export type LiveDeviceState = z.infer<typeof liveDeviceStateSchema>;

export const liveAlarmSchema = z
  .object({
    alarmId: z.string().uuid(),
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
  })
  .strict();
export type LiveAlarm = z.infer<typeof liveAlarmSchema>;

/** Виды кадров. Имя вида это и `event:` в потоке, и ключ разбора на клиенте. */
export const LIVE_EVENT_KINDS = [
  'hello',
  'resync',
  'ping',
  'reading',
  'device-state',
  'alarm',
] as const;
export const liveEventKindSchema = z.enum(LIVE_EVENT_KINDS);
export type LiveEventKind = z.infer<typeof liveEventKindSchema>;

/**
 * Разобранный кадр. Разделение по виду события, а не по форме данных: у потока событий
 * вид приходит отдельным полем, и угадывать его по содержимому незачем.
 */
export const liveFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hello'), id: z.string().min(1), data: liveHelloSchema }).strict(),
  z.object({ kind: z.literal('resync'), id: z.string().min(1), data: liveResyncSchema }).strict(),
  z.object({ kind: z.literal('ping'), id: z.string().min(1), data: livePingSchema }).strict(),
  z.object({ kind: z.literal('reading'), id: z.string().min(1), data: liveReadingSchema }).strict(),
  z
    .object({ kind: z.literal('device-state'), id: z.string().min(1), data: liveDeviceStateSchema })
    .strict(),
  z.object({ kind: z.literal('alarm'), id: z.string().min(1), data: liveAlarmSchema }).strict(),
]);
export type LiveFrame = z.infer<typeof liveFrameSchema>;

/**
 * Ключ подписки: площадка, линия, прибор или роль. Тот же ключ живёт в событии и в запросе
 * подписки, поэтому набор видов здесь обязан совпадать с тем, что кладёт в событие шлюз.
 */
export const liveSubscriptionKeySchema = z
  .string()
  .regex(/^(site|line|device|role|topic):[A-Za-z0-9._-]+$/, 'ожидается вид device:RC-101');
export type LiveSubscriptionKey = z.infer<typeof liveSubscriptionKeySchema>;
