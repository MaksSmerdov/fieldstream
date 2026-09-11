import { Inject, Injectable } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import type { Consumer, EachBatchPayload } from 'kafkajs';
import type pg from 'pg';
import { TOPICS } from '@fieldstream/contracts';
import type { PollCycle } from '@fieldstream/contracts';
import { insertPollCycles, withTransaction } from '@fieldstream/db';
import type { PollCycleRow } from '@fieldstream/db';
import type { Clock } from '@fieldstream/domain';
import { createConsumer, decodeMessage } from '@fieldstream/kafka';
import { createLogThrottle } from '@fieldstream/nest-common';
import type { Logger } from '@fieldstream/nest-common';
import { HealthService } from '../health/health.service.js';
import type { ProcessorMetrics } from '../metrics/metrics.js';
import { ProducerService } from '../publish/producer.service.js';
import { DeviceRefsService } from '../topology/device-refs.service.js';
import { CLOCK, LOGGER, METRICS, POOL } from '../tokens.js';

export const CYCLES_GROUP = 'fs-processor-cycles';
const RETRY_MS = 2_000;

/**
 * Потребитель циклов опроса: пишет их в гипертаблицу и кормит трекер здоровья.
 * Счётчики отказов обновляются только после записи: повторная доставка иначе удвоила бы их.
 */
@Injectable()
export class CyclesConsumerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly consumer: Consumer;
  private readonly throttle: (key: string) => { pass: boolean };
  private running = false;

  public constructor(
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(CLOCK) clock: Clock,
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(METRICS) private readonly metrics: ProcessorMetrics,
    producer: ProducerService,
    private readonly refs: DeviceRefsService,
    private readonly health: HealthService,
  ) {
    this.consumer = createConsumer(producer.kafka, CYCLES_GROUP);
    this.throttle = createLogThrottle(clock);
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
    await this.consumer.subscribe({ topic: TOPICS.pollCycles.name, fromBeginning: true });
    await this.consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: (payload) => this.handleBatch(payload),
    });
    this.running = true;
  }

  private async handleBatch(payload: EachBatchPayload): Promise<void> {
    const { batch } = payload;
    const lastOffset = batch.messages.at(-1)?.offset;
    if (lastOffset === undefined) return;
    if (!this.refs.isLoaded()) {
      setTimeout(payload.pause(), RETRY_MS).unref();
      return;
    }

    const refs = this.refs.current();
    const cycles: PollCycle[] = [];
    const rows: PollCycleRow[] = [];

    for (const message of batch.messages) {
      const decoded = decodeMessage(TOPICS.pollCycles, message.value, message.headers);
      if (!decoded.ok) {
        if (this.throttle(`cycle:${decoded.errorClass}`).pass) {
          this.log.warn(
            { offset: message.offset, error: decoded.error },
            'цикл опроса не разобран, пропущен',
          );
        }
        continue;
      }

      const ref = refs.get(decoded.payload.deviceCode);
      if (ref === undefined) continue;
      cycles.push(decoded.payload);
      rows.push({
        ts: decoded.payload.ts,
        lineId: ref.lineId,
        deviceId: ref.deviceId,
        ok: decoded.payload.ok,
        errorKind: decoded.payload.errorKind,
        durationMs: decoded.payload.durationMs,
        requestCount: decoded.payload.requestCount,
        planMode: decoded.payload.planMode,
      });
    }

    try {
      const inserted = await withTransaction(this.pool, (client) => insertPollCycles(client, rows));
      this.metrics.observeRows('poll_cycles', inserted);
    } catch (error) {
      this.metrics.observeTransient(batch.topic);
      if (this.throttle('cycles-write').pass) {
        this.log.warn(
          { err: error, partition: batch.partition },
          'циклы не записаны: партиция на паузе',
        );
      }
      setTimeout(payload.pause(), RETRY_MS).unref();
      return;
    }

    for (const cycle of cycles) this.health.observeCycle(cycle);
    payload.resolveOffset(lastOffset);
    await payload.commitOffsetsIfNecessary();
    await payload.heartbeat();
  }
}
