import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { Producer } from 'kafkajs';
import type { z } from 'zod';
import type { TopicSpec } from '@fieldstream/contracts';
import type { Clock } from '@fieldstream/domain';
import { createKafkaClient, createProducer, encodeMessage, sendMessages } from '@fieldstream/kafka';
import type { KafkaLog } from '@fieldstream/kafka';
import type { Env } from '../config/env.js';
import type { Logger } from '../logging/logger.js';
import { createLogThrottle } from '../logging/throttle.js';
import type { CollectorMetrics } from '../metrics/metrics.js';
import { CLOCK, ENV, LOGGER, METRICS } from '../tokens.js';
import { createBoundedPublisher } from './bounded-publisher.js';
import type { BoundedPublisher } from './bounded-publisher.js';

const PRODUCER_NAME = 'edge-collector';
const BATCH_SIZE = 200;
const RETRY_DELAY_MS = 1_000;
const DRAIN_ON_SHUTDOWN_MS = 5_000;
const STALLED_AFTER_MS = 15_000;
const METRICS_INTERVAL_MS = 5_000;

/** Логи kafkajs с подавлением дублей: при недоступном брокере он повторяет одно и то же каждую секунду. */
const throttledKafkaLog = (log: Logger, clock: Clock): KafkaLog => {
  const throttle = createLogThrottle(clock);
  const passed = (
    fields: Record<string, unknown>,
    message: string,
  ): Record<string, unknown> | null => {
    const namespace = typeof fields.namespace === 'string' ? fields.namespace : '';
    const decision = throttle(`${namespace}:${message}`);
    return decision.pass ? { ...fields, suppressed: decision.suppressed } : null;
  };

  return {
    error: (fields, message) => {
      const kept = passed(fields, message);
      if (kept !== null) log.error(kept, message);
    },
    warn: (fields, message) => {
      const kept = passed(fields, message);
      if (kept !== null) log.warn(kept, message);
    },
    info: (fields, message) => {
      log.info(fields, message);
    },
    debug: (fields, message) => {
      log.debug(fields, message);
    },
  };
};

/**
 * Публикация в Kafka. Опрос никогда не ждёт брокер: сообщение кладётся в ограниченный буфер,
 * отправка идёт в фоне. Недоступная Kafka не роняет сервис, он честно сообщает, что не готов.
 */
@Injectable()
export class KafkaPublisher implements OnModuleInit, OnApplicationShutdown {
  private readonly producer: Producer;
  private readonly buffer: BoundedPublisher;
  private readonly log: Logger;
  private readonly metrics: CollectorMetrics;
  private metricsTimer: NodeJS.Timeout | null = null;
  private connected = false;

  public constructor(
    @Inject(ENV) env: Env,
    @Inject(LOGGER) log: Logger,
    @Inject(METRICS) metrics: CollectorMetrics,
    @Inject(CLOCK) clock: Clock,
  ) {
    this.log = log;
    this.metrics = metrics;
    this.producer = createProducer(
      createKafkaClient({
        clientId: env.KAFKA_CLIENT_ID,
        brokers: env.KAFKA_BROKERS,
        log: throttledKafkaLog(log, clock),
      }),
    );
    this.producer.on(this.producer.events.CONNECT, () => {
      this.connected = true;
    });
    this.producer.on(this.producer.events.DISCONNECT, () => {
      this.connected = false;
    });

    this.buffer = createBoundedPublisher({
      capacity: env.COLLECTOR_BUFFER_CAPACITY,
      batchSize: BATCH_SIZE,
      retryDelayMs: RETRY_DELAY_MS,
      now: () => clock.now(),
      send: async (batch) => {
        await sendMessages(this.producer, batch);
      },
      onDrop: (count) => {
        metrics.observeDropped(count);
        log.warn({ dropped: count }, 'буфер Kafka переполнен, самые старые сообщения отброшены');
      },
      onError: (error) => {
        log.warn({ err: error }, 'отправка в Kafka не удалась, повтор');
      },
    });
  }

  public onModuleInit(): void {
    this.producer.connect().catch((error: unknown) => {
      this.log.error({ err: error }, 'не удалось подключиться к Kafka');
    });
    this.metricsTimer = setInterval(() => {
      this.metrics.setBuffer(this.buffer.size());
      this.metrics.setBufferAge(this.buffer.oldestAgeMs());
    }, METRICS_INTERVAL_MS);
    this.metricsTimer.unref();
  }

  public async onApplicationShutdown(): Promise<void> {
    if (this.metricsTimer !== null) clearInterval(this.metricsTimer);
    await Promise.race([
      this.buffer.drain(),
      new Promise((resolve) => setTimeout(resolve, DRAIN_ON_SHUTDOWN_MS)),
    ]);
    this.buffer.close();
    await this.producer.disconnect();
  }

  /**
   * Данные доходят до брокера. Одного флага подключения мало: kafkajs не сообщает
   * об отключении, когда брокер пропал сам, поэтому смотрим, не залежалось ли сообщение в буфере.
   */
  public isHealthy(): boolean {
    return this.connected && this.buffer.oldestAgeMs() < STALLED_AFTER_MS;
  }

  public bufferSize(): number {
    return this.buffer.size();
  }

  public oldestPendingMs(): number {
    return this.buffer.oldestAgeMs();
  }

  /** Кладёт сообщение в буфер. Ошибка схемы это баг сборщика: она пишется в лог, опрос не падает. */
  public publish<S extends z.ZodTypeAny>(
    spec: TopicSpec<S>,
    payload: z.infer<S>,
    traceId: string,
  ): void {
    try {
      this.buffer.enqueue(encodeMessage(spec, payload, { producer: PRODUCER_NAME, traceId }));
    } catch (error) {
      this.log.error({ err: error, topic: spec.name }, 'сообщение не прошло схему топика');
    }
  }
}
