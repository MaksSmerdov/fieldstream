import { Inject, Injectable } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import type { Consumer, EachMessagePayload } from 'kafkajs';
import type pg from 'pg';
import { TOPICS } from '@fieldstream/contracts';
import { recordAppliedCommand, withTransaction } from '@fieldstream/db';
import { createConsumer, decodeMessage } from '@fieldstream/kafka';
import type { Logger } from '@fieldstream/nest-common';
import { ProducerService } from '../publish/producer.service.js';
import { LOGGER, POOL } from '../tokens.js';

export const RESULTS_GROUP = 'fs-processor-commands';

/**
 * Ответы исполнителей команд. В таблицу их переносит процессор, единственный писатель схемы.
 * Повтор сообщения ничего не меняет, ключ идемпотентности это сама команда.
 */
@Injectable()
export class CommandResultsService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly consumer: Consumer;
  private running = false;

  public constructor(
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(POOL) private readonly pool: pg.Pool,
    producer: ProducerService,
  ) {
    this.consumer = createConsumer(producer.kafka, RESULTS_GROUP);
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
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({ topic: TOPICS.commandResults.name, fromBeginning: true });
      await this.consumer.run({ eachMessage: (payload) => this.handle(payload) });
      this.running = true;
    } catch (error) {
      this.log.warn({ err: error }, 'приём ответов на команды не поднялся, повтор');
      setTimeout(() => {
        void this.start();
      }, 5_000).unref();
    }
  }

  private async handle(payload: EachMessagePayload): Promise<void> {
    const decoded = decodeMessage(
      TOPICS.commandResults,
      payload.message.value,
      payload.message.headers,
    );
    if (!decoded.ok) {
      this.log.warn({ error: decoded.error }, 'ответ на команду не разбирается схемой, пропущен');
      return;
    }

    const result = decoded.payload;
    const written = await withTransaction(this.pool, (client) =>
      recordAppliedCommand(client, {
        commandId: result.commandId,
        lineCode: result.lineCode,
        kind: result.kind,
        args: {},
        appliedAt: result.appliedAt,
        result: { status: result.status, detail: result.detail },
      }),
    );

    if (written) {
      this.log.info(
        { commandId: result.commandId, status: result.status },
        'ответ на команду записан',
      );
    }
  }
}
