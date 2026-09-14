import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type pg from 'pg';
import { DEFAULT_HEALTH_POLICY, TOPICS } from '@fieldstream/contracts';
import type { DeviceEvent, DeviceState, PollCycle } from '@fieldstream/contracts';
import {
  insertDeviceEvents,
  lockDeviceStateHandover,
  upsertDeviceStates,
  withTransaction,
} from '@fieldstream/db';
import { DEMO_STAND } from '@fieldstream/device-profiles';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import { createLogThrottle } from '@fieldstream/nest-common';
import type { Logger } from '@fieldstream/nest-common';
import type { Env } from '../config/env.js';
import { ProducerService } from '../publish/producer.service.js';
import { DeviceRefsService } from '../topology/device-refs.service.js';
import { CLOCK, ENV, LOGGER, POOL } from '../tokens.js';
import { createHealthTracker } from './tracker.js';
import type { FrameDraft, HealthTracker } from './tracker.js';

/**
 * Здоровье приборов. Раз в несколько секунд строит дерево, сохраняет состояние в базу
 * и публикует его в компактируемый топик. Неудача не теряет ни состояние, ни события:
 * они уйдут при следующей проверке. Запись идёт под общей блокировкой переезда, и уже под ней
 * проверяется, что ребаланс не начался, а прибор всё ещё свой: новый владелец читает состояние
 * под исключительной блокировкой и не пропустит запись, которая к этому моменту уже идёт.
 */
@Injectable()
export class HealthService implements OnModuleInit, OnModuleDestroy {
  private readonly tracker: HealthTracker;
  private readonly pool: pg.Pool;
  private readonly log: Logger;
  private readonly clock: Clock;
  private readonly intervalMs: number;
  private readonly throttle: (key: string) => { pass: boolean };
  private pendingEvents: DeviceEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private held: () => boolean = () => false;

  public constructor(
    @Inject(ENV) env: Env,
    @Inject(LOGGER) log: Logger,
    @Inject(CLOCK) clock: Clock,
    @Inject(POOL) pool: pg.Pool,
    private readonly producer: ProducerService,
    private readonly refs: DeviceRefsService,
  ) {
    this.pool = pool;
    this.log = log;
    this.clock = clock;
    this.intervalMs = env.HEALTH_INTERVAL_MS;
    this.throttle = createLogThrottle(clock);
    this.tracker = createHealthTracker({ stand: DEMO_STAND, clock, policy: DEFAULT_HEALTH_POLICY });
  }

  public onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
  }

  /** Остановка до выхода потребителя из группы: после неё здоровье уже ничего не пишет. */
  public onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
  }

  public observeCycle(cycle: PollCycle): void {
    this.tracker.observeCycle(cycle);
  }

  /** Черновик событий кадров пачки: потребитель применяет его после записи. */
  public draftFrames(): FrameDraft {
    return this.tracker.draftFrames();
  }

  /** Условие, пока верно которое публикация ждёт: ребаланс начался, а назначение ещё не применено. */
  public holdWhile(held: () => boolean): void {
    this.held = held;
  }

  /** Отобранные при ребалансе приборы: их состояние теперь публикует новый владелец. */
  public release(deviceCodes: readonly string[]): void {
    this.tracker.release(deviceCodes);
  }

  /** Новые приборы экземпляра вместе с последним записанным состоянием, null если его не прочитать. */
  public adopt(deviceCodes: readonly string[], restored: readonly DeviceState[] | null): void {
    this.tracker.adopt(deviceCodes, restored);
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped || this.held() || !this.refs.isLoaded()) return;
    this.ticking = true;

    try {
      const { states, events } = this.tracker.evaluate();
      this.pendingEvents.push(...events);
      if (states.length === 0 && this.pendingEvents.length === 0) return;

      const refs = this.refs.current();
      const updatedAt = toIsoTimestamp(this.clock.now());
      const idOf = (code: string): number | undefined => refs.get(code)?.deviceId;
      const pending = this.pendingEvents;

      const written = await withTransaction(this.pool, async (client) => {
        await lockDeviceStateHandover(client, 'publish');
        if (this.stopped || this.held()) return null;

        const own = states.filter((state) => this.tracker.owns(state.deviceCode));
        await upsertDeviceStates(
          client,
          own.flatMap((state) => {
            const deviceId = idOf(state.deviceCode);
            return deviceId === undefined ? [] : [{ deviceId, state, updatedAt }];
          }),
        );
        await insertDeviceEvents(
          client,
          pending.flatMap((event) => {
            const deviceId = idOf(event.deviceCode);
            return deviceId === undefined || !this.tracker.owns(event.deviceCode)
              ? []
              : [{ deviceId, event }];
          }),
        );
        return own;
      });
      if (written === null) return;
      this.pendingEvents = this.pendingEvents.slice(pending.length);

      await this.producer.send(
        written.map((state) => this.producer.encode(TOPICS.deviceState, state, state.deviceCode)),
      );
      this.tracker.confirmPublished(written);
      if (written.length > 0)
        this.log.info({ changed: written.length }, 'состояние приборов обновлено');
    } catch (error) {
      if (this.throttle('health-tick').pass) {
        this.log.warn(
          { err: error },
          'проверка здоровья не сохранилась, повтор на следующем такте',
        );
      }
    } finally {
      this.ticking = false;
    }
  }
}
