import { z } from 'zod';
import { telemetryRawSchema, telemetryReadingSchema } from '../messages/telemetry.js';
import { alarmEventSchema } from '../messages/alarms.js';
import { commandResultSchema, deviceCommandSchema } from '../messages/commands.js';
import { lineStatusSchema } from '../messages/collector.js';
import { deviceStateSchema, pollCycleSchema } from '../messages/events.js';

/**
 * Единственное место, где описаны топики. Отсюда собирается конфиг создания топиков
 * и страница контрактов в интерфейсе.
 */
export interface TopicSpec<S extends z.ZodTypeAny> {
  readonly name: string;
  readonly schema: S;
  /** Ключ партиционирования. Порядок гарантируется только внутри одного ключа. */
  readonly keyOf: (payload: z.infer<S>) => string;
  readonly partitions: number;
  readonly cleanupPolicy: 'delete' | 'compact';
  readonly retentionMs: number | null;
  /** Настройки топика сверх политики очистки и срока хранения. */
  readonly configs?: Readonly<Record<string, string>>;
  /** Сервис, которому разрешено писать в топик. Двух писателей быть не должно. */
  readonly owner: string;
  /**
   * Сервис, который возвращает сообщения из очереди недоставленных в этот топик с исходным ключом.
   * Единственное исключение из правила одного писателя: пишутся только исходные байты, а не новые данные.
   */
  readonly redriver?: string;
  readonly why: string;
}

const define = <S extends z.ZodTypeAny>(spec: TopicSpec<S>): TopicSpec<S> => spec;

const DAY_MS = 86_400_000;

/** Байты исходного сообщения как есть: неразбираемое сообщение иначе физически не положить в очередь. */
const rawBytesSchema = z.custom<Uint8Array>(
  (value) => value instanceof Uint8Array,
  'ожидаются сырые байты',
);

export const TOPICS = {
  telemetryRaw: define({
    name: 'fieldstream.telemetry.raw.v1',
    schema: telemetryRawSchema,
    keyOf: (p) => p.deviceCode,
    partitions: 6,
    cleanupPolicy: 'delete',
    retentionMs: 7 * DAY_MS,
    configs: { 'compression.type': 'gzip' },
    owner: 'edge-collector',
    redriver: 'stream-processor',
    why:
      'Семь дней это окно реплея: сырые кадры позволяют переиграть историю исправленным декодером. ' +
      'Процессор возвращает сюда сообщения из очереди недоставленных с исходным ключом: ' +
      'это единственное исключение из правила одного писателя.',
  }),
  pollCycles: define({
    name: 'fieldstream.collector.cycles.v2',
    schema: pollCycleSchema,
    keyOf: (p) => p.deviceCode,
    partitions: 6,
    cleanupPolicy: 'delete',
    retentionMs: 3 * DAY_MS,
    owner: 'edge-collector',
    why:
      'Пишется даже когда прибор не ответил и кадра нет: иначе отказ невидим. ' +
      'Ключ и число партиций как у сырых кадров: цикл прибора ложится в партицию с тем же номером, ' +
      'что и его кадры, и оба потока одного прибора обрабатывает один экземпляр процессора.',
  }),
  lineStatus: define({
    name: 'fieldstream.collector.status.v1',
    schema: lineStatusSchema,
    keyOf: (p) => p.lineCode,
    partitions: 3,
    cleanupPolicy: 'compact',
    retentionMs: null,
    configs: { 'segment.ms': '60000', 'min.cleanable.dirty.ratio': '0.1' },
    owner: 'edge-collector',
    why:
      'Снимок линии: размыкатели, лестница переподключения, сторож цикла и время ответа. ' +
      'Сборщик стоит за NAT, поэтому его состояние едет топиком, а компакция хранит последний снимок линии.',
  }),
  telemetryReadings: define({
    name: 'fieldstream.telemetry.readings.v1',
    schema: telemetryReadingSchema,
    keyOf: (p) => p.deviceCode,
    partitions: 6,
    cleanupPolicy: 'delete',
    retentionMs: DAY_MS,
    owner: 'stream-processor',
    why: 'Шина живого фан-аута, а не хранилище: источник истины по истории это гипертаблица.',
  }),
  deviceState: define({
    name: 'fieldstream.device.state.v1',
    schema: deviceStateSchema,
    keyOf: (p) => p.deviceCode,
    partitions: 3,
    cleanupPolicy: 'compact',
    retentionMs: null,
    configs: {
      'min.cleanable.dirty.ratio': '0.1',
      'segment.ms': '60000',
      'delete.retention.ms': '3600000',
      'max.compaction.lag.ms': '300000',
    },
    owner: 'stream-processor',
    why:
      'Компактируемый топик хранит последнее состояние прибора, ключ это идентификатор узла. ' +
      'Сегменты по минуте выставлены под демо: компакция срабатывает за минуты, а не за сутки.',
  }),
  alarmEvents: define({
    name: 'fieldstream.alarms.events.v1',
    schema: alarmEventSchema,
    keyOf: (p) => p.deviceCode,
    partitions: 3,
    cleanupPolicy: 'delete',
    retentionMs: 30 * DAY_MS,
    owner: 'stream-processor',
    why: 'Критичен порядок raised перед cleared внутри прибора, а не глобальный порядок по правилу.',
  }),
  deviceCommands: define({
    name: 'fieldstream.device.commands.v1',
    schema: deviceCommandSchema,
    keyOf: (p) => p.siteCode,
    partitions: 3,
    cleanupPolicy: 'delete',
    retentionMs: 7 * DAY_MS,
    owner: 'api-gateway',
    why:
      'Ключ это площадка: команды одной площадке применяются по порядку, чужие сборщик пропускает. ' +
      'При десятках площадок правильнее топик на площадку, здесь их две.',
  }),
  commandResults: define({
    name: 'fieldstream.device.commands.results.v1',
    schema: commandResultSchema,
    keyOf: (p) => p.commandId,
    partitions: 3,
    cleanupPolicy: 'compact',
    retentionMs: null,
    configs: { 'segment.ms': '60000', 'min.cleanable.dirty.ratio': '0.1' },
    owner: 'edge-collector',
    why:
      'Сборщик про базу не знает: он стоит за NAT и наружу ходит только к брокеру. ' +
      'Факт применения едет сюда, а в таблицу его переносит процессор.',
  }),
  telemetryRawDlq: define({
    name: 'fieldstream.telemetry.raw.dlq.v1',
    schema: rawBytesSchema,
    keyOf: () => '',
    partitions: 1,
    cleanupPolicy: 'delete',
    retentionMs: 14 * DAY_MS,
    owner: 'stream-processor',
    why:
      'Сырые байты без попытки разбора и ключ исходного сообщения: после повторной подачи ' +
      'кадр вернётся в ту же партицию, и порядок внутри прибора не развалится.',
  }),
} as const;

export type TopicKey = keyof typeof TOPICS;
export type PayloadOf<K extends TopicKey> = z.infer<(typeof TOPICS)[K]['schema']>;

export const TOPIC_NAMES: readonly string[] = Object.values(TOPICS).map((t) => t.name);

/** Заголовки сообщения. Версия схемы едет рядом, чтобы консьюмер не гадал. */
export const KAFKA_HEADERS = Object.freeze({
  schema: 'x-schema',
  schemaVersion: 'x-schema-version',
  traceId: 'x-trace-id',
  dlqOriginTopic: 'x-dlq-origin-topic',
  dlqOriginPartition: 'x-dlq-origin-partition',
  dlqOriginOffset: 'x-dlq-origin-offset',
  dlqOriginTimestamp: 'x-dlq-origin-timestamp',
  dlqErrorClass: 'x-dlq-error-class',
  dlqError: 'x-dlq-error',
  dlqAttempt: 'x-dlq-attempt',
  dlqFirstFailedAt: 'x-dlq-first-failed-at',
  dlqConsumerGroup: 'x-dlq-consumer-group',
  dlqRedriveOf: 'x-dlq-redrive-of',
});
