import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { Kafka, Producer } from 'kafkajs';
import type { z } from 'zod';
import type { TopicSpec } from '@fieldstream/contracts';
import type { Clock } from '@fieldstream/domain';
import {
  createKafkaClient,
  createProducer,
  encodeMessage,
  sendMessages,
  sendRawMessages,
} from '@fieldstream/kafka';
import type { OutgoingMessage, RawOutgoingMessage } from '@fieldstream/kafka';
import { createThrottledLog } from '@fieldstream/nest-common';
import type { Logger } from '@fieldstream/nest-common';
import type { Env } from '../config/env.js';
import { CLOCK, ENV, LOGGER } from '../tokens.js';

export const PRODUCER_NAME = 'api-gateway';
const RECONNECT_DELAY_MS = 2_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Продюсер шлюза. Повторы конечные: сообщение, которое не ушло в брокер, остаётся в очереди
 * исходящих, и следующая попытка идёт по расписанию, а не бесконечным ожиданием внутри запроса.
 */
@Injectable()
export class ProducerService implements OnModuleInit, OnApplicationShutdown {
  public readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly log: Logger;
  private connected = false;
  private stopping = false;

  public constructor(
    @Inject(ENV) env: Env,
    @Inject(LOGGER) log: Logger,
    @Inject(CLOCK) clock: Clock,
  ) {
    this.log = log;
    this.kafka = createKafkaClient({
      clientId: env.KAFKA_CLIENT_ID,
      brokers: env.KAFKA_BROKERS,
      log: createThrottledLog(log, clock),
    });
    this.producer = createProducer(this.kafka, {
      retry: { retries: 5, initialRetryTime: 300, maxRetryTime: 10_000 },
    });
    this.producer.on(this.producer.events.CONNECT, () => {
      this.connected = true;
    });
    this.producer.on(this.producer.events.DISCONNECT, () => {
      this.connected = false;
      if (!this.stopping) void this.connectLoop();
    });
  }

  public onModuleInit(): void {
    void this.connectLoop();
  }

  public async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.producer.disconnect();
  }

  public isConnected(): boolean {
    return this.connected;
  }

  /** Сообщение для топика из манифеста от имени процессора. */
  public encode<S extends z.ZodTypeAny>(
    spec: TopicSpec<S>,
    payload: z.infer<S>,
    traceId: string,
  ): OutgoingMessage {
    return encodeMessage(spec, payload, { producer: PRODUCER_NAME, traceId });
  }

  public async send(messages: readonly OutgoingMessage[]): Promise<void> {
    await sendMessages(this.producer, messages);
  }

  public async sendRaw(messages: readonly RawOutgoingMessage[]): Promise<void> {
    await sendRawMessages(this.producer, messages);
  }

  /** Подключение в фоне: недоступный брокер не роняет сервис, он просто не готов. */
  private async connectLoop(): Promise<void> {
    while (!this.connected && !this.stopping) {
      try {
        await this.producer.connect();
      } catch (error) {
        this.log.warn({ err: error }, 'продюсер не подключился к Kafka, повтор');
        await sleep(RECONNECT_DELAY_MS);
      }
    }
  }
}
