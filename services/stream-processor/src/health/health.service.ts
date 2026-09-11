import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type pg from 'pg';
import { DEFAULT_HEALTH_POLICY, TOPICS } from '@fieldstream/contracts';
import type { DeviceEvent, PollCycle } from '@fieldstream/contracts';
import { insertDeviceEvents, upsertDeviceStates, withTransaction } from '@fieldstream/db';
import { DEMO_STAND } from '@fieldstream/device-profiles';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import { createLogThrottle } from '@fieldstream/nest-common';
import type { Logger } from '@fieldstream/nest-common';
import type { Env } from '../config/env.js';
import type { FrameObservation } from '../ingest/frame.js';
import { ProducerService } from '../publish/producer.service.js';
import { DeviceRefsService } from '../topology/device-refs.service.js';
import { CLOCK, ENV, LOGGER, POOL } from '../tokens.js';
import { createHealthTracker } from './tracker.js';
import type { HealthTracker } from './tracker.js';

/**
 * Здоровье приборов. Раз в несколько секунд строит дерево, сохраняет состояние в базу
 * и публикует его в компактируемый топик. Неудача не теряет ни состояние, ни события:
 * они уйдут при следующей проверке.
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

  public onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  public observeCycle(cycle: PollCycle): void {
    this.tracker.observeCycle(cycle);
  }

  /** События из кадров: их пишет потребитель кадров в той же транзакции, что и показания. */
  public observeFrame(observation: FrameObservation): DeviceEvent[] {
    return this.tracker.observeFrame(observation);
  }

  private async tick(): Promise<void> {
    if (this.ticking || !this.refs.isLoaded()) return;
    this.ticking = true;

    try {
      const { states, events } = this.tracker.evaluate();
      this.pendingEvents.push(...events);
      if (states.length === 0 && this.pendingEvents.length === 0) return;

      const refs = this.refs.current();
      const updatedAt = toIsoTimestamp(this.clock.now());
      const idOf = (code: string): number | undefined => refs.get(code)?.deviceId;
      const pending = this.pendingEvents;

      await withTransaction(this.pool, async (client) => {
        await upsertDeviceStates(
          client,
          states.flatMap((state) => {
            const deviceId = idOf(state.deviceCode);
            return deviceId === undefined ? [] : [{ deviceId, state, updatedAt }];
          }),
        );
        await insertDeviceEvents(
          client,
          pending.flatMap((event) => {
            const deviceId = idOf(event.deviceCode);
            return deviceId === undefined ? [] : [{ deviceId, event }];
          }),
        );
      });
      this.pendingEvents = this.pendingEvents.slice(pending.length);

      await this.producer.send(
        states.map((state) => this.producer.encode(TOPICS.deviceState, state, state.deviceCode)),
      );
      this.tracker.confirmPublished(states);
      if (states.length > 0)
        this.log.info({ changed: states.length }, 'состояние приборов обновлено');
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
