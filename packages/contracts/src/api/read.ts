import { z } from 'zod';
import {
  deviceCodeSchema,
  gatewayCodeSchema,
  isoTimestampSchema,
  lineCodeSchema,
  qualitySchema,
  siteCodeSchema,
  slaveIdSchema,
} from '../primitives.js';
import { healthReasonSchema, healthStatusSchema } from '../messages/health.js';
import { deviceModeSchema, planModeSchema, registerTypeSchema } from '../topology/device.js';
import { severitySchema } from '../messages/alarms.js';

/** Прибор в дереве объектов: адрес, состояние и сколько у него незакрытых алармов. */
export const topologyDeviceSchema = z
  .object({
    code: deviceCodeSchema,
    label: z.string().min(1),
    profileKey: z.string().min(1),
    profileVersion: z.number().int().min(1),
    slaveId: slaveIdSchema,
    enabled: z.boolean(),
    status: healthStatusSchema,
    reason: healthReasonSchema,
    mode: deviceModeSchema,
    since: isoTimestampSchema.nullable(),
    lastOkAt: isoTimestampSchema.nullable(),
    activeAlarms: z.number().int().min(0),
    worstSeverity: severitySchema.nullable(),
    /**
     * Значения прибора устарели. Решает сервер по такту опроса линии, фронт только рисует
     * прочерк: иначе каждый экран решал бы сам, что такое «давно не было данных».
     */
    stale: z.boolean(),
    /** Момент последнего значения. Пусто, если за последний час их не было вовсе. */
    staleSince: isoTimestampSchema.nullable(),
  })
  .strict();
export type TopologyDevice = z.infer<typeof topologyDeviceSchema>;

export const topologyLineSchema = z
  .object({
    code: lineCodeSchema,
    baud: z.number().int().min(1),
    pollIntervalMs: z.number().int().min(1),
    requestTimeoutMs: z.number().int().min(1),
    planMode: planModeSchema,
    enabled: z.boolean(),
    devices: z.array(topologyDeviceSchema),
  })
  .strict();
export type TopologyLine = z.infer<typeof topologyLineSchema>;

export const topologyGatewaySchema = z
  .object({
    code: gatewayCodeSchema,
    host: z.string().min(1),
    lines: z.array(topologyLineSchema),
  })
  .strict();
export type TopologyGateway = z.infer<typeof topologyGatewaySchema>;

export const topologySiteSchema = z
  .object({
    code: siteCodeSchema,
    name: z.string().min(1),
    timezone: z.string().min(1),
    gateways: z.array(topologyGatewaySchema),
  })
  .strict();
export type TopologySite = z.infer<typeof topologySiteSchema>;

export const topologyResponseSchema = z
  .object({ sites: z.array(topologySiteSchema), serverTime: isoTimestampSchema })
  .strict();
export type TopologyResponse = z.infer<typeof topologyResponseSchema>;

/** Значение метрики в снимке: рядом с числом едет и его описание, и качество. */
export const snapshotMetricSchema = z
  .object({
    metricKey: z.string().min(1),
    label: z.string().min(1),
    unit: z.string().nullable(),
    kind: z.enum(['number', 'enum', 'bits']),
    precision: z.number().int().min(0),
    value: z.number().nullable(),
    quality: qualitySchema,
    ts: isoTimestampSchema.nullable(),
  })
  .strict();
export type SnapshotMetric = z.infer<typeof snapshotMetricSchema>;

/**
 * Снимок прибора. Признак устаревания считает сервер: у браузера свои часы, и без общей
 * точки отсчёта каждый экран решал бы сам, что такое «давно не было данных».
 */
export const deviceSnapshotSchema = z
  .object({
    deviceCode: deviceCodeSchema,
    label: z.string().min(1),
    lineCode: lineCodeSchema,
    siteCode: siteCodeSchema,
    profileKey: z.string().min(1),
    profileVersion: z.number().int().min(1),
    status: healthStatusSchema,
    reason: healthReasonSchema,
    mode: deviceModeSchema,
    since: isoTimestampSchema.nullable(),
    lastOkAt: isoTimestampSchema.nullable(),
    consecutiveErrors: z.number().int().min(0),
    stale: z.boolean(),
    ts: isoTimestampSchema.nullable(),
    metrics: z.array(snapshotMetricSchema),
    activeAlarms: z.number().int().min(0),
    serverTime: isoTimestampSchema,
  })
  .strict();
export type DeviceSnapshot = z.infer<typeof deviceSnapshotSchema>;

export const seriesSourceSchema = z.enum(['readings', 'readings_1m', 'readings_1h']);
export type SeriesSourceName = z.infer<typeof seriesSourceSchema>;

/** Точка серии: среднее с краями интервала, чтобы график не врал на прореженных данных. */
export const seriesPointSchema = z
  .object({
    t: isoTimestampSchema,
    avg: z.number().nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    n: z.number().int().min(0),
  })
  .strict();
export type SeriesPoint = z.infer<typeof seriesPointSchema>;

export const seriesMetricSchema = z
  .object({ metricKey: z.string().min(1), points: z.array(seriesPointSchema) })
  .strict();
export type SeriesMetric = z.infer<typeof seriesMetricSchema>;

/**
 * Откуда взяты данные и с каким шагом. Эти же поля показывает бейдж под графиком:
 * подпись не может разойтись с источником, потому что приходит вместе с данными.
 */
export const seriesMetaSchema = z
  .object({
    source: seriesSourceSchema,
    bucketMs: z.number().int().min(1),
    points: z.number().int().min(0),
    truncated: z.boolean(),
    from: isoTimestampSchema,
    to: isoTimestampSchema,
  })
  .strict();
export type SeriesMeta = z.infer<typeof seriesMetaSchema>;

export const seriesResponseSchema = z
  .object({
    deviceCode: deviceCodeSchema,
    metrics: z.array(seriesMetricSchema),
    meta: seriesMetaSchema,
  })
  .strict();
export type SeriesResponse = z.infer<typeof seriesResponseSchema>;

export const seriesQuerySchema = z
  .object({
    metrics: z
      .string()
      .min(1)
      .transform((value) =>
        value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      ),
    from: isoTimestampSchema,
    to: isoTimestampSchema,
    maxPoints: z.coerce.number().int().min(10).max(5_000).optional(),
  })
  .strict();
export type SeriesQuery = z.infer<typeof seriesQuerySchema>;

/** Блок плана чтения: один запрос к прибору и параметры, которые он закрывает. */
export const readPlanBlockSchema = z
  .object({
    id: z.string().min(1),
    registerType: registerTypeSchema,
    startAddress: z.number().int().min(0),
    registerCount: z.number().int().min(1),
    paramKeys: z.array(z.string().min(1)),
    source: z.enum(['declared', 'merged', 'naive']),
  })
  .strict();

/**
 * Карта регистров прибора в двух видах. Разница между merged и naive это и есть выигрыш
 * склейки блоков: на экране видно, сколько запросов уходит на линию в каждом случае.
 */
export const readPlanResponseSchema = z
  .object({
    deviceCode: deviceCodeSchema,
    profileKey: z.string().min(1),
    profileVersion: z.number().int().min(1),
    mode: planModeSchema,
    requests: z.number().int().min(1),
    registers: z.number().int().min(1),
    blocks: z.array(readPlanBlockSchema),
  })
  .strict();
export type ReadPlanResponse = z.infer<typeof readPlanResponseSchema>;

/** Параметр прибора так, как его показывает экран: значение, единица, словарь состояний. */
export const profileParamViewSchema = z
  .object({
    metricKey: z.string().min(1),
    label: z.string().min(1),
    unit: z.string().nullable(),
    precision: z.number().int().min(0),
    kind: z.enum(['number', 'enum', 'bits']),
    /** Словарь кодов состояния: без него перечисление рисуется числом. */
    states: z.record(z.string(), z.string()).nullable(),
    /** Разряды слова аварий с их именами. */
    bits: z
      .array(
        z.object({ bit: z.number().int().min(0), key: z.string(), label: z.string() }).strict(),
      )
      .nullable(),
    range: z.object({ min: z.number(), max: z.number() }).strict().nullable(),
  })
  .strict();
export type ProfileParamView = z.infer<typeof profileParamViewSchema>;

export const profileSectionViewSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    params: z.array(profileParamViewSchema),
  })
  .strict();

/**
 * Описание модели прибора для экрана: секции в том же порядке, что у профиля, чтобы
 * значения группировались так же, как их видит инженер в документации на прибор.
 */
export const deviceProfileViewSchema = z
  .object({
    deviceCode: deviceCodeSchema,
    profileKey: z.string().min(1),
    profileVersion: z.number().int().min(1),
    label: z.string().min(1),
    sections: z.array(profileSectionViewSchema),
  })
  .strict();
export type DeviceProfileView = z.infer<typeof deviceProfileViewSchema>;
