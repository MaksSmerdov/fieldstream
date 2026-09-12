import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type pg from 'pg';
import { TOPICS, deviceCommandSchema } from '@fieldstream/contracts';
import { claimOutbox, markOutboxFailed, markOutboxPublished } from '@fieldstream/db';
import type { OutboxRow } from '@fieldstream/db';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import type { OutgoingMessage } from '@fieldstream/kafka';
import type { Logger } from '@fieldstream/nest-common';
import { withClient } from '../common/with-client.js';
import type { Env } from '../config/env.js';
import { ProducerService } from '../publish/producer.service.js';
import { CLOCK, ENV, LOGGER, POOL } from '../tokens.js';

/** Отсрочка перед следующей попыткой: растёт с числом неудач, но не выше минуты. */
const retryDelayMs = (attempts: number): number => Math.min(60_000, 500 * 2 ** (attempts - 1));

/**
 * Отправка очереди исходящих в брокер. Команда попадает в очередь той же транзакцией,
 * в которой её приняли, поэтому откат не оставляет сообщения в топике. Повторная публикация
 * безвредна: у сообщения свой ключ, и приёмник гасит дубль.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly lockId = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  public constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly log: Logger,
    private readonly producer: ProducerService,
  ) {}

  public onApplicationBootstrap(): void {
    if (this.env.OUTBOX_RELAY === 'off') {
      this.log.info({}, 'рассылка очереди исходящих выключена: команды остаются в очереди');
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.env.OUTBOX_POLL_MS);
    this.timer.unref();
  }

  public onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Один проход очереди. Возвращает число отправленных сообщений: по нему удобно ждать в тестах. */
  public async tick(): Promise<number> {
    if (this.env.OUTBOX_RELAY === 'off') return 0;
    if (this.ticking || !this.producer.isConnected()) return 0;
    this.ticking = true;

    try {
      const rows = await withClient(this.pool, (client) =>
        claimOutbox(client, this.lockId, this.env.OUTBOX_BATCH),
      );
      if (rows.length === 0) return 0;

      const messages: OutgoingMessage[] = [];
      const ids: string[] = [];
      const broken: string[] = [];

      for (const row of rows) {
        const message = this.toMessage(row);
        if (message === null) broken.push(row.id);
        else {
          messages.push(message);
          ids.push(row.id);
        }
      }

      if (broken.length > 0) {
        await withClient(this.pool, (client) =>
          markOutboxFailed(
            client,
            broken,
            'сообщение не разбирается схемой своего топика',
            toIsoTimestamp(this.clock.now() + 60_000),
          ),
        );
      }
      if (messages.length === 0) return 0;

      try {
        await this.producer.send(messages);
        await withClient(this.pool, (client) =>
          markOutboxPublished(client, ids, toIsoTimestamp(this.clock.now())),
        );
        return messages.length;
      } catch (error) {
        const delay = retryDelayMs(rows[0]?.attempts ?? 1);
        await withClient(this.pool, (client) =>
          markOutboxFailed(
            client,
            ids,
            error instanceof Error ? error.message : String(error),
            toIsoTimestamp(this.clock.now() + delay),
          ),
        );
        this.log.warn({ err: error, delayMs: delay }, 'очередь исходящих не ушла в брокер');
        return 0;
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Строка очереди превращается в сообщение только через схему своего топика. */
  private toMessage(row: OutboxRow): OutgoingMessage | null {
    if (row.topic !== TOPICS.deviceCommands.name) return null;

    const parsed = deviceCommandSchema.safeParse(row.payload);
    if (!parsed.success) return null;

    return this.producer.encode(TOPICS.deviceCommands, parsed.data, parsed.data.traceId);
  }
}
