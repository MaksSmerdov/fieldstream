import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { Producer } from 'kafkajs';
import type { z } from 'zod';
import type { TopicSpec } from '@fieldstream/contracts';
import { createKafkaClient, createProducer, encodeMessage, sendMessages } from '@fieldstream/kafka';
import type { Env } from '../config/env.js';
import type { Logger } from '../logging/logger.js';
import type { CollectorMetrics } from '../metrics/metrics.js';
import { ENV, LOGGER, METRICS } from '../tokens.js';
import { createBoundedPublisher } from './bounded-publisher.js';
import type { BoundedPublisher } from './bounded-publisher.js';

const PRODUCER_NAME = 'edge-collector';
const BATCH_SIZE = 200;
const RETRY_DELAY_MS = 1_000;
const DRAIN_ON_SHUTDOWN_MS = 5_000;

/**
 * Публикация в Kafka. Опрос никогда не ждёт брокер: сообщение кладётся в ограниченный буфер,
 * отправка идёт в фоне. Недоступная Kafka не роняет сервис, он честно сообщает, что не готов.
 */
@Injectable()
export class KafkaPublisher implements OnModuleInit, OnApplicationShutdown {
  private readonly producer: Producer;
  private readonly buffer: BoundedPublisher;
  private readonly log: Logger;
  private connected = false;

  public constructor(
    @Inject(ENV) env: Env,
    @Inject(LOGGER) log: Logger,
    @Inject(METRICS) metrics: CollectorMetrics,
  ) {
    this.log = log;
    this.producer = createProducer(
      createKafkaClient({ clientId: env.KAFKA_CLIENT_ID, brokers: env.KAFKA_BROKERS, log }),
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
      send: async (batch) => {
        await sendMessages(this.producer, batch);
        metrics.setBuffer(this.buffer.size());
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
  }

  public async onApplicationShutdown(): Promise<void> {
    await Promise.race([
      this.buffer.drain(),
      new Promise((resolve) => setTimeout(resolve, DRAIN_ON_SHUTDOWN_MS)),
    ]);
    this.buffer.close();
    await this.producer.disconnect();
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public bufferSize(): number {
    return this.buffer.size();
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
