import { Inject, Injectable } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import type { Consumer, EachBatchPayload, IMemberAssignment } from 'kafkajs';
import type pg from 'pg';
import { TOPICS } from '@fieldstream/contracts';
import type { DeviceState } from '@fieldstream/contracts';
import {
  loadDeviceStates,
  loadOpenAlarmEpisodes,
  lockDeviceStateHandover,
  withTransaction,
} from '@fieldstream/db';
import type { OpenAlarmEpisode } from '@fieldstream/db';
import { DEMO_STAND } from '@fieldstream/device-profiles';
import { createConsumer, createCoPartitionAssigner } from '@fieldstream/kafka';
import type { Logger } from '@fieldstream/nest-common';
import { HealthService } from '../health/health.service.js';
import { ProducerService } from '../publish/producer.service.js';
import { DeviceRefsService } from '../topology/device-refs.service.js';
import { LOGGER, POOL } from '../tokens.js';
import { INGEST_GROUP, createHandovers } from './assignment.js';
import type { Handovers, Ownership } from './assignment.js';
import { CyclesBatchService } from './cycles-batch.service.js';
import { RawBatchService } from './raw-batch.service.js';

export type { Ownership } from './assignment.js';

const STAND_CODES: readonly string[] = DEMO_STAND.devices.map((device) => device.code);
const RESTORE_DELAYS_MS = [500, 1_000, 2_000] as const;
const RESTORE_ATTEMPT_MS = 2_500;

interface Restored {
  readonly episodes: readonly OpenAlarmEpisode[];
  readonly states: readonly DeviceState[];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Промис с ограничением по времени: зависшая база не должна держать очередь переездов. */
const withinMs = <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`нет ответа за ${String(ms)} мс`));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
  });
};

/** Коды приборов по порядку: стенд и всё, что есть в топологии базы. */
const knownCodes = (refs: Iterable<string>): string[] =>
  [...new Set([...STAND_CODES, ...refs])].sort();

/**
 * Потребитель процессора. Сырые кадры и циклы опроса читаются одной группой с назначателем
 * ко-партиционирования: партиция с номером N обоих топиков всегда у одного экземпляра, и все
 * данные прибора обрабатывает он один. Прибор свой, если его ключ ведёт в назначенную партицию.
 * На каждое вступление в группу отобранные приборы забываются, новые получают из базы открытые
 * эпизоды и последнее состояние, и пачки ждут, пока это восстановление закончится. Падение или
 * остановка потребителя отдают всё: участник уже вышел из группы, и его партиции у других.
 * С начала ребаланса и до конца переезда здоровье не публикуется.
 */
@Injectable()
export class IngestConsumerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly consumer: Consumer;
  private readonly handovers: Handovers;
  private codes: readonly string[] = knownCodes([]);
  private seenRefs: ReadonlyMap<string, unknown> | null = null;
  private running = false;

  public constructor(
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(POOL) private readonly pool: pg.Pool,
    producer: ProducerService,
    private readonly refs: DeviceRefsService,
    private readonly raw: RawBatchService,
    private readonly cycles: CyclesBatchService,
    private readonly health: HealthService,
  ) {
    this.handovers = createHandovers({
      codes: () => this.codes,
      release: (deviceCodes) => {
        this.raw.release(deviceCodes);
        this.health.release(deviceCodes);
      },
      adopt: (deviceCodes) => this.adopt(deviceCodes),
      settled: (ownership, handover) => {
        this.log.info(
          {
            partitions: ownership?.partitions ?? [],
            devices: ownership?.devices.size ?? 0,
            released: handover.released.length,
            adopted: handover.adopted.length,
          },
          ownership === null
            ? 'экземпляр вне группы: приборы отданы'
            : 'назначение партиций принято',
        );
      },
      failed: (error) => {
        this.log.error({ err: error }, 'назначение партиций не применилось');
      },
    });
    this.health.holdWhile(() => this.handovers.settling());

    this.consumer = createConsumer(producer.kafka, INGEST_GROUP, {
      partitionAssigners: [createCoPartitionAssigner],
    });
    this.consumer.on(this.consumer.events.REBALANCING, () => {
      this.handovers.announce();
    });
    this.consumer.on(this.consumer.events.GROUP_JOIN, (event) => {
      this.running = true;
      void this.handovers.assign(
        event.payload.memberId,
        this.rawPartitions(event.payload.memberAssignment),
      );
    });
    this.consumer.on(this.consumer.events.STOP, () => {
      this.running = false;
      void this.handovers.revoke();
    });
    this.consumer.on(this.consumer.events.CRASH, () => {
      this.running = false;
      void this.handovers.revoke();
    });
  }

  public onApplicationBootstrap(): void {
    void this.start();
  }

  public async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.consumer.disconnect();
  }

  /** Работает, пока участник в группе: после падения или остановки до следующего вступления нет. */
  public isRunning(): boolean {
    return this.running;
  }

  /** Партиции и приборы экземпляра. Вне группы null: своего нет ничего. */
  public ownership(): Ownership | null {
    return this.handovers.ownership();
  }

  private async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({
      topics: [TOPICS.telemetryRaw.name, TOPICS.pollCycles.name],
      fromBeginning: true,
    });
    await this.consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: (payload) => this.handleBatch(payload),
    });
  }

  private rawPartitions(assignment: IMemberAssignment): number[] {
    return [...(assignment[TOPICS.telemetryRaw.name] ?? [])];
  }

  private async adopt(deviceCodes: readonly string[]): Promise<void> {
    if (deviceCodes.length === 0) return;
    const restored = await this.restore(deviceCodes);
    this.raw.adopt(deviceCodes, restored?.episodes ?? []);
    this.health.adopt(deviceCodes, restored?.states ?? null);
    if (restored !== null) {
      this.log.info(
        {
          devices: deviceCodes.length,
          episodes: restored.episodes.length,
          states: restored.states.length,
        },
        'состояние новых приборов восстановлено',
      );
    }
  }

  /**
   * Открытые эпизоды и последнее состояние новых приборов. Каждая попытка ограничена по времени,
   * а все вместе заметно короче таймаута сессии: пачки ждут переезда, и без предела экземпляр
   * вылетел бы из группы. После последней попытки null и честная запись в журнал.
   */
  private async restore(deviceCodes: readonly string[]): Promise<Restored | null> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await withinMs(this.readRestored(deviceCodes), RESTORE_ATTEMPT_MS);
      } catch (error) {
        const delay = RESTORE_DELAYS_MS[attempt];
        if (delay === undefined) {
          this.log.warn(
            { err: error, devices: deviceCodes.length },
            'состояние новых приборов не восстановлено: их открытые эпизоды останутся в базе незакрытыми до ручного снятия, по той же метрике может открыться повторный, здоровье начнётся с нуля',
          );
          return null;
        }
        await sleep(delay);
      }
    }
  }

  /** Чтение под исключительной блокировкой переезда: проверка здоровья прежнего владельца уже записана. */
  private readRestored(deviceCodes: readonly string[]): Promise<Restored> {
    return withTransaction(this.pool, async (client) => {
      await lockDeviceStateHandover(client, 'adopt', RESTORE_ATTEMPT_MS);
      const episodes = await loadOpenAlarmEpisodes(client, deviceCodes);
      const states = await loadDeviceStates(client, deviceCodes);
      return { episodes, states };
    });
  }

  /** Прибор, появившийся в топологии базы, принимается без ожидания следующего ребаланса. */
  private followTopology(): void {
    const refs = this.refs.current();
    if (refs === this.seenRefs) return;
    this.seenRefs = refs;
    const codes = knownCodes(refs.keys());
    if (codes.join() === this.codes.join()) return;
    this.codes = codes;
    void this.handovers.refresh();
  }

  private async handleBatch(payload: EachBatchPayload): Promise<void> {
    this.followTopology();
    await this.handovers.ready();

    if (payload.batch.topic === TOPICS.telemetryRaw.name) {
      await this.raw.handle(payload);
    } else if (payload.batch.topic === TOPICS.pollCycles.name) {
      await this.cycles.handle(payload);
    }
  }
}
