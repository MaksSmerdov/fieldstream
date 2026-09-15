import { Inject, Injectable } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import type pg from 'pg';
import { TOPICS } from '@fieldstream/contracts';
import type { DlqRedrive } from '@fieldstream/contracts';
import {
  claimDlqRedrive,
  failStaleDlqRedrives,
  finishDlqRedrive,
  markDlqFinalRejected,
  markDlqResolved,
  selectDlqForRedrive,
  withTransaction,
} from '@fieldstream/db';
import type { DlqRedriveCandidate } from '@fieldstream/db';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import { toRedriveMessage } from '@fieldstream/kafka';
import type { RawOutgoingMessage, RedriveTarget } from '@fieldstream/kafka';
import { createLogThrottle } from '@fieldstream/nest-common';
import type { Logger } from '@fieldstream/nest-common';
import type { Env } from '../config/env.js';
import { PRODUCER_NAME, ProducerService } from '../publish/producer.service.js';
import { CLOCK, ENV, LOGGER, POOL } from '../tokens.js';

/** С какой по счёту неудачи сообщение больше не подаётся. */
export const FINAL_ATTEMPTS = 3;

/** Текст ошибки у запроса, брошенного в работе прежним выполнением. */
export const STALE_RUNNING_ERROR =
  'процессор остановился посреди выполнения, запрос не завершён: поставьте новый';

/** Топики, в которые манифест разрешает процессору возвращать сообщения. */
const REDRIVABLE: ReadonlyMap<string, RedriveTarget> = new Map(
  Object.values(TOPICS)
    .filter((spec) => spec.redriver === PRODUCER_NAME)
    .map((spec) => [spec.name, spec]),
);

interface RedriveCounts {
  readonly redriven: number;
  readonly rejected: number;
}

/** Запрос, забранный в текущей транзакции: по нему записывается сбой после отката. */
interface Claim {
  request: DlqRedrive | null;
}

/**
 * Повторная подача из очереди недоставленных. Интерфейс кладёт запрос в базу, а в брокер пишет
 * процессор: у него уже есть продюсер и право на исходный топик по манифесту. Забор запроса,
 * отбор сообщений с блокировкой строк, отметки и завершение идут одной транзакцией, поэтому
 * убитый посреди работы процесс возвращает запрос в очередь, а не оставляет его в работе.
 * Исчерпавшие попытки помечаются окончательно отвергнутыми, остальные уходят в исходный топик
 * с исходным ключом и только после отправки считаются разобранными. Сбой откатывает всё,
 * а запрос отдельно завершается с ошибкой.
 */
@Injectable()
export class DlqRedriveService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly throttle: (key: string) => { pass: boolean };
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<boolean> | null = null;
  private stopped = false;
  private recovered = false;

  public constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(POOL) private readonly pool: pg.Pool,
    private readonly producer: ProducerService,
  ) {
    this.throttle = createLogThrottle(clock);
  }

  public onApplicationBootstrap(): void {
    if (this.env.DLQ_REDRIVE === 'off') {
      this.log.info({}, 'повторная подача выключена: запросы остаются в очереди');
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.env.DLQ_REDRIVE_POLL_MS);
    this.timer.unref();
  }

  /** Остановка до отключения продюсера: начатый запрос доводится до конца, новый не берётся. */
  public async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    await this.current;
  }

  /** Один проход: забирает запрос и выполняет его целиком. Истина, если запрос был. */
  public tick(): Promise<boolean> {
    if (this.env.DLQ_REDRIVE === 'off' || this.stopped || this.current !== null) {
      return Promise.resolve(false);
    }
    if (!this.producer.isConnected()) return Promise.resolve(false);

    const run = this.runOnce().finally(() => {
      this.current = null;
    });
    this.current = run;
    return run;
  }

  private async runOnce(): Promise<boolean> {
    if (!this.recovered && !(await this.recoverStale())) return false;
    const claim: Claim = { request: null };

    try {
      const counts = await withTransaction(this.pool, async (client) => {
        const request = await claimDlqRedrive(client);
        if (request === null) return null;
        claim.request = request;
        return this.execute(client, request);
      });
      if (claim.request === null || counts === null) return false;

      this.log.info(
        { redriveId: claim.request.id, requestedBy: claim.request.requestedBy, ...counts },
        'повторная подача выполнена',
      );
      return true;
    } catch (error) {
      if (claim.request === null) {
        if (this.throttle('redrive-claim').pass) {
          this.log.warn(
            { err: error },
            'запрос повторной подачи не забран, повтор на следующем такте',
          );
        }
        return false;
      }

      await this.fail(claim.request, error);
      return true;
    }
  }

  /**
   * Первым делом после старта завершает с ошибкой запросы, брошенные в работе прежним
   * выполнением: иначе интерфейс ждал бы их вечно. Истина, если это сделано.
   */
  private async recoverStale(): Promise<boolean> {
    try {
      const failed = await withTransaction(this.pool, (client) =>
        failStaleDlqRedrives(client, STALE_RUNNING_ERROR, toIsoTimestamp(this.clock.now())),
      );
      this.recovered = true;
      if (failed > 0) {
        this.log.warn(
          { failed },
          'брошенные в работе запросы повторной подачи завершены с ошибкой',
        );
      }
      return true;
    } catch (error) {
      if (this.throttle('redrive-recover').pass) {
        this.log.warn(
          { err: error },
          'брошенные запросы повторной подачи не проверены, повтор на следующем такте',
        );
      }
      return false;
    }
  }

  /** Отбор, отметки, отправка и завершение запроса в транзакции, забравшей запрос. */
  private async execute(client: pg.PoolClient, request: DlqRedrive): Promise<RedriveCounts> {
    const rows = await selectDlqForRedrive(client, {
      topics: [...REDRIVABLE.keys()],
      limit: request.maxMessages,
    });
    const rejected = rows.filter((row) => row.attempts >= FINAL_ATTEMPTS);
    const due = rows.filter((row) => row.attempts < FINAL_ATTEMPTS);

    await markDlqFinalRejected(
      client,
      rejected.map((row) => row.id),
    );
    await this.producer.sendRaw(due.map((row) => this.toMessage(row)));
    await markDlqResolved(
      client,
      due.map((row) => row.id),
      toIsoTimestamp(this.clock.now()),
    );

    const counts = { redriven: due.length, rejected: rejected.length };
    await finishDlqRedrive(
      client,
      request.id,
      { status: 'done', ...counts, error: null },
      toIsoTimestamp(this.clock.now()),
    );
    return counts;
  }

  /**
   * Запрос завершается с текстом ошибки. Откат вернул его в очередь, поэтому если и эту отметку
   * не записать, запрос не повиснет: его выполнит следующий такт.
   */
  private async fail(request: DlqRedrive, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.log.warn({ err: error, redriveId: request.id }, 'повторная подача не удалась');

    try {
      await withTransaction(this.pool, (client) =>
        finishDlqRedrive(
          client,
          request.id,
          { status: 'failed', redriven: 0, rejected: 0, error: message },
          toIsoTimestamp(this.clock.now()),
        ),
      );
    } catch (finishError) {
      this.log.error(
        { err: finishError, redriveId: request.id },
        'сбой повторной подачи не записан, запрос остался в очереди',
      );
    }
  }

  /** Строка базы превращается в сообщение только через манифест исходного топика. */
  private toMessage(row: DlqRedriveCandidate): RawOutgoingMessage {
    const spec = REDRIVABLE.get(row.sourceTopic);
    if (spec === undefined)
      throw new Error(`в топик ${row.sourceTopic} повторная подача не разрешена`);

    return toRedriveMessage(
      spec,
      {
        id: row.id,
        key: row.key === null ? null : Buffer.from(row.key, 'utf8'),
        value: row.payload,
        headers: row.headers,
        attempts: row.attempts,
        firstFailedAt: row.firstSeen,
      },
      PRODUCER_NAME,
    );
  }
}
