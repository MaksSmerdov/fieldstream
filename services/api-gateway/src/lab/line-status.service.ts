import { Inject, Injectable } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import type { Consumer, EachMessagePayload } from 'kafkajs';
import { TOPICS } from '@fieldstream/contracts';
import type { LineStatus } from '@fieldstream/contracts';
import type { Clock } from '@fieldstream/domain';
import { createConsumer, createKafkaClient, decodeMessage } from '@fieldstream/kafka';
import { createThrottledLog } from '@fieldstream/nest-common';
import type { Logger } from '@fieldstream/nest-common';
import type { Env } from '../config/env.js';
import { CLOCK, ENV, INSTANCE_ID, LOGGER } from '../tokens.js';

const RETRY_MS = 5_000;

/**
 * Последние снимки линий от сборщика. Смещения не подтверждаются вовсе: каждый запуск
 * перечитывает компактируемый топик с начала и сразу знает последний снимок каждой линии.
 */
@Injectable()
export class LineStatusService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly consumer: Consumer;
  private readonly group: string;
  private readonly latest = new Map<string, LineStatus>();
  private stopping = false;

  public constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(CLOCK) clock: Clock,
    @Inject(INSTANCE_ID) instanceId: string,
  ) {
    const kafka = createKafkaClient({
      clientId: `${env.KAFKA_CLIENT_ID}-${instanceId}`,
      brokers: env.KAFKA_BROKERS,
      log: createThrottledLog(log, clock),
    });
    this.group = `fs-api-status-${instanceId}`;
    this.consumer = createConsumer(kafka, this.group);
  }

  public onApplicationBootstrap(): void {
    if (this.env.COLLECTOR_STATUS === 'off') {
      this.log.info({}, 'чтение снимков линий выключено: статус линий пуст');
      return;
    }

    void this.start();
  }

  public async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.env.COLLECTOR_STATUS === 'off') return;
    await this.consumer.disconnect();
  }

  /** Запоминает снимок линии, если он не старше уже известного. */
  public record(status: LineStatus): void {
    const known = this.latest.get(status.lineCode);
    if (known !== undefined && Date.parse(known.ts) > Date.parse(status.ts)) return;

    this.latest.set(status.lineCode, status);
  }

  /** Последние снимки по порядку кодов линий. */
  public lines(): LineStatus[] {
    return [...this.latest.values()].sort((left, right) =>
      left.lineCode.localeCompare(right.lineCode, 'en', { numeric: true }),
    );
  }

  private async start(): Promise<void> {
    if (this.stopping) return;

    try {
      await this.consumer.connect();
      await this.consumer.subscribe({ topics: [TOPICS.lineStatus.name], fromBeginning: true });
      await this.consumer.run({
        autoCommit: false,
        eachMessage: (payload) => this.handle(payload),
      });
      this.log.info({ group: this.group }, 'снимки линий читаются из брокера');
    } catch (error) {
      this.log.warn(
        { err: error },
        'чтение снимков линий не поднялось, повтор через несколько секунд',
      );
      setTimeout(() => {
        void this.start();
      }, RETRY_MS).unref();
    }
  }

  private handle(payload: EachMessagePayload): Promise<void> {
    const { message } = payload;
    const decoded = decodeMessage(TOPICS.lineStatus, message.value, message.headers);
    if (decoded.ok) this.record(decoded.payload);

    return Promise.resolve();
  }
}
