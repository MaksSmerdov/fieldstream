import { Inject, Injectable } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import type { Consumer, EachBatchPayload, KafkaMessage } from 'kafkajs';
import type pg from 'pg';
import { TOPICS } from '@fieldstream/contracts';
import type { TelemetryReading } from '@fieldstream/contracts';
import {
  insertDeviceEvents,
  insertReadings,
  recordDlqMessages,
  withTransaction,
} from '@fieldstream/db';
import type { DeviceEventRow, DlqRow, ReadingRow } from '@fieldstream/db';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock, SpikeFilterState } from '@fieldstream/domain';
import {
  commitThrough,
  createConsumer,
  decodeMessage,
  headerText,
  toDlqMessage,
} from '@fieldstream/kafka';
import type { RawOutgoingMessage } from '@fieldstream/kafka';
import type { Logger } from '@fieldstream/nest-common';
import { HealthService } from '../health/health.service.js';
import type { ProcessorMetrics } from '../metrics/metrics.js';
import { PRODUCER_NAME, ProducerService } from '../publish/producer.service.js';
import { DeviceRefsService } from '../topology/device-refs.service.js';
import { CLOCK, LOGGER, METRICS, POOL } from '../tokens.js';
import { processFrame } from './frame.js';

export const RAW_GROUP = 'fs-processor';
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [200, 500, 1_000, 2_500, 5_000] as const;

interface Poisoned {
  readonly message: KafkaMessage;
  readonly errorClass: string;
  readonly error: string;
}

/** Задержка перед повтором попытки номер attempt с джиттером, чтобы партиции не шли в ногу. */
const backoffMs = (attempt: number): number => {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] ?? 5_000;
  return Math.round(base * (0.9 + Math.random() * 0.2));
};

/** Заголовки строками для таблицы очереди недоставленных. */
const textHeaders = (message: KafkaMessage): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const name of Object.keys(message.headers ?? {})) {
    const value = headerText(message.headers, name);
    if (value !== null) headers[name] = value;
  }
  return headers;
};

/**
 * Потребитель сырых кадров. Порядок строгий: разбор всей пачки, одна транзакция с показаниями
 * и событиями, отправка ядовитых сообщений в очередь недоставленных, публикация показаний,
 * и только потом подтверждение смещения. Падение между записью и подтверждением даёт повтор,
 * а повтор ничего не меняет: ключи идемпотентности лежат в схеме базы.
 */
@Injectable()
export class RawConsumerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly consumer: Consumer;
  private readonly attempts = new Map<number, number>();
  private filters = new Map<string, SpikeFilterState>();
  private running = false;

  public constructor(
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(METRICS) private readonly metrics: ProcessorMetrics,
    private readonly producer: ProducerService,
    private readonly refs: DeviceRefsService,
    private readonly health: HealthService,
  ) {
    this.consumer = createConsumer(producer.kafka, RAW_GROUP);
  }

  public onApplicationBootstrap(): void {
    void this.start();
  }

  public async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.consumer.disconnect();
  }

  public isRunning(): boolean {
    return this.running;
  }

  private async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: TOPICS.telemetryRaw.name, fromBeginning: true });
    await this.consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: (payload) => this.handleBatch(payload),
    });
    this.running = true;
  }

  private async handleBatch(payload: EachBatchPayload): Promise<void> {
    const { batch } = payload;
    if (!this.refs.isLoaded()) {
      this.pauseFor(payload, 1, 'топология ещё не загружена');
      return;
    }

    const startedAt = this.clock.now();
    const filters = new Map(this.filters);
    const rows: ReadingRow[] = [];
    const readings: TelemetryReading[] = [];
    const events: DeviceEventRow[] = [];
    const poisoned: Poisoned[] = [];
    let lastOffset: string | null = null;

    for (const message of batch.messages) {
      if (!payload.isRunning() || payload.isStale()) break;
      lastOffset = message.offset;

      const decoded = decodeMessage(TOPICS.telemetryRaw, message.value, message.headers);
      if (!decoded.ok) {
        poisoned.push({ message, errorClass: decoded.errorClass, error: decoded.error });
        continue;
      }

      const outcome = processFrame(decoded.payload, {
        refs: this.refs.current(),
        filters,
        source: { partition: batch.partition, offset: message.offset },
      });
      if (outcome.kind === 'rejected') {
        poisoned.push({ message, errorClass: outcome.errorClass, error: outcome.error });
        continue;
      }

      for (const [key, state] of outcome.filters) filters.set(key, state);
      rows.push(...outcome.rows);
      readings.push(outcome.reading);
      const deviceId = this.refs.current().get(outcome.observation.deviceCode)?.deviceId;
      if (deviceId !== undefined) {
        for (const event of this.health.observeFrame(outcome.observation)) {
          events.push({ deviceId, event });
        }
      }
    }

    if (lastOffset === null) return;

    const failedAt = toIsoTimestamp(this.clock.now());
    const dlqMessages: RawOutgoingMessage[] = poisoned.map((item) =>
      toDlqMessage(
        TOPICS.telemetryRawDlq,
        {
          topic: batch.topic,
          partition: batch.partition,
          offset: item.message.offset,
          timestamp: item.message.timestamp,
          key: item.message.key,
          value: item.message.value,
          headers: item.message.headers,
        },
        {
          errorClass: item.errorClass,
          error: item.error,
          consumerGroup: RAW_GROUP,
          attempt: 1,
          firstFailedAt: failedAt,
        },
        PRODUCER_NAME,
      ),
    );
    const dlqRows: DlqRow[] = poisoned.map((item) => ({
      sourceTopic: batch.topic,
      partition: batch.partition,
      offset: item.message.offset,
      key: item.message.key?.toString('utf8') ?? null,
      headers: textHeaders(item.message),
      payload: item.message.value,
      errorClass: item.errorClass,
      error: item.error,
    }));

    try {
      const inserted = await withTransaction(this.pool, async (client) => {
        const count = await insertReadings(client, rows);
        await insertDeviceEvents(client, events);
        await recordDlqMessages(client, dlqRows);
        return count;
      });
      await this.producer.sendRaw(dlqMessages);
      await this.producer.send(
        readings.map((reading) =>
          this.producer.encode(TOPICS.telemetryReadings, reading, reading.traceId),
        ),
      );

      this.metrics.observeRows('readings', inserted);
      this.metrics.observeFrames('accepted', readings.length);
      for (const item of poisoned) {
        this.metrics.observeDlq(item.errorClass);
        this.log.warn(
          {
            partition: batch.partition,
            offset: item.message.offset,
            errorClass: item.errorClass,
            error: item.error,
          },
          'кадр отправлен в очередь недоставленных',
        );
      }
    } catch (error) {
      this.metrics.observeTransient(batch.topic);
      const attempt = (this.attempts.get(batch.partition) ?? 0) + 1;
      this.attempts.set(batch.partition, attempt);

      if (attempt > MAX_ATTEMPTS) {
        this.log.fatal(
          { err: error, partition: batch.partition, attempts: attempt },
          'сбой не прошёл за пять попыток: процесс завершается, перезапуск за Docker',
        );
        process.exit(1);
      }
      this.pauseFor(payload, attempt, 'сбой записи или публикации', error);
      return;
    }

    this.attempts.delete(batch.partition);
    this.filters = filters;
    await commitThrough(payload, lastOffset);
    await payload.heartbeat();
    this.metrics.observeBatch(batch.topic, this.clock.now() - startedAt);
  }

  /** Пауза партиции без подтверждения смещения: после неё kafkajs отдаст ту же пачку заново. */
  private pauseFor(
    payload: EachBatchPayload,
    attempt: number,
    reason: string,
    error?: unknown,
  ): void {
    const delay = backoffMs(attempt);
    const resume = payload.pause();
    setTimeout(resume, delay).unref();
    this.log.warn(
      { err: error, partition: payload.batch.partition, attempt, delayMs: delay },
      `${reason}: партиция на паузе`,
    );
  }
}
