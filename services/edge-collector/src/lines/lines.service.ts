import { Inject, Injectable } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { TOPICS } from '@fieldstream/contracts';
import type { Stand, StandLine } from '@fieldstream/contracts';
import { DEMO_STAND } from '@fieldstream/device-profiles';
import type { PlanMode } from '@fieldstream/device-profiles';
import type { Clock } from '@fieldstream/domain';
import type { Env } from '../config/env.js';
import type { Logger } from '@fieldstream/nest-common';
import type { CollectorMetrics } from '../metrics/metrics.js';
import { createLineWorker } from '../polling/line-worker.js';
import type { LineSnapshot, LineWorker } from '../polling/line-worker.js';
import { KafkaPublisher } from '../publish/kafka-publisher.js';
import { createModbusLink } from '../transport/modbus-link.js';
import { CLOCK, ENV, LOGGER, METRICS } from '../tokens.js';

/** Линии, которые обслуживает этот сборщик. Неизвестный код это ошибка конфигурации, а не пропуск. */
export const selectLines = (stand: Stand, codes: readonly string[] | undefined): StandLine[] => {
  if (codes === undefined) return [...stand.lines];

  const unknown = codes.filter((code) => !stand.lines.some((line) => line.code === code));
  if (unknown.length > 0) {
    throw new Error(`COLLECTOR_LINES: на стенде нет линий ${unknown.join(', ')}`);
  }
  return stand.lines.filter((line) => codes.includes(line.code));
};

/** Воркеры линий: по одному на линию, запускаются после старта приложения. */
@Injectable()
export class LinesService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly workers: readonly LineWorker[];
  private readonly log: Logger;

  public constructor(
    @Inject(ENV) env: Env,
    @Inject(LOGGER) log: Logger,
    @Inject(CLOCK) clock: Clock,
    @Inject(METRICS) metrics: CollectorMetrics,
    publisher: KafkaPublisher,
  ) {
    this.log = log;
    this.workers = selectLines(DEMO_STAND, env.COLLECTOR_LINES).map((line) => {
      const gateway = DEMO_STAND.gateways.find((candidate) => candidate.code === line.gatewayCode);
      const host = env.MODBUS_HOST_OVERRIDE ?? gateway?.host ?? line.gatewayCode;

      return createLineWorker({
        stand: DEMO_STAND,
        line,
        host,
        link: createModbusLink({ host, port: line.port, requestTimeoutMs: line.requestTimeoutMs }),
        clock,
        random: Math.random,
        log,
        publishRaw: (frame) => {
          publisher.publish(TOPICS.telemetryRaw, frame, frame.traceId);
        },
        publishCycle: (cycle) => {
          publisher.publish(TOPICS.pollCycles, cycle, cycle.traceId);
        },
        onPoll: (errorKind) => {
          metrics.observePoll(line.code, errorKind);
        },
        onCycle: (report, openBreakers) => {
          metrics.observeCycle(line.code, report.durationMs);
          metrics.setOpenBreakers(line.code, openBreakers);
          metrics.setBuffer(publisher.bufferSize());
        },
        onReconnect: () => {
          metrics.observeReconnect(line.code);
        },
      });
    });
  }

  public onApplicationBootstrap(): void {
    for (const worker of this.workers) worker.start();
    this.log.info(
      { lines: this.workers.map((worker) => worker.lineCode) },
      'воркеры линий запущены',
    );
  }

  public async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.stop()));
  }

  public lineCount(): number {
    return this.workers.length;
  }

  public snapshot(): LineSnapshot[] {
    return this.workers.map((worker) => worker.snapshot());
  }

  /** Переключает режим плана чтения линии. Ложь, если такой линии у сборщика нет. */
  public setPlanMode(lineCode: string, mode: PlanMode): boolean {
    const worker = this.workers.find((candidate) => candidate.lineCode === lineCode);
    if (worker === undefined) return false;
    worker.setPlanMode(mode);
    this.log.info({ line: lineCode, mode }, 'режим плана чтения изменён');
    return true;
  }
}
