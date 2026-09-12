import { Inject, Injectable } from '@nestjs/common';
import type { MessageEvent, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { hasPermission } from '@fieldstream/contracts';
import type { ModuleId } from '@fieldstream/contracts';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import type { Env } from '../config/env.js';
import type { GatewayMetrics } from '../metrics/metrics.js';
import { CLOCK, ENV, METRICS } from '../tokens.js';
import { LiveRing } from './live-ring.js';
import type { LiveEvent, LiveEventKind } from './live-ring.js';

/** Какое право открывает события этого вида. Имя модуля то же, что у маршрута и у guard. */
const REQUIRED: Readonly<Record<LiveEventKind, ModuleId | null>> = {
  reading: 'devices',
  'device-state': 'devices',
  alarm: 'alarms',
  ping: null,
  hello: null,
};

export interface StreamOptions {
  readonly lastEventId: string | null;
  readonly permissions: readonly ModuleId[];
  /** Подписка экрана прибора: пустое множество означает «всё, что разрешено правами». */
  readonly devices: ReadonlySet<string> | null;
}

const toMessage = (event: LiveEvent): MessageEvent => ({
  id: event.id,
  type: event.kind,
  data: event.data,
});

/**
 * Шина живого канала. Одно соединение на вкладку, поверх него кольцо последних событий:
 * после обрыва клиент либо получает пропущенное, либо узнаёт, что пропустил слишком много.
 */
@Injectable()
export class LiveBusService implements OnModuleInit, OnModuleDestroy {
  private readonly channel = new Subject<LiveEvent>();
  private readonly ring: LiveRing;
  private ping: NodeJS.Timeout | undefined;
  private streams = 0;

  public constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(METRICS) private readonly metrics: GatewayMetrics,
  ) {
    this.ring = new LiveRing(env.SSE_RING_SIZE, clock.now());
  }

  public onModuleInit(): void {
    this.ping = setInterval(() => {
      this.publish('ping', [], { at: toIsoTimestamp(this.clock.now()) });
    }, this.env.SSE_PING_MS);
    this.ping.unref();
  }

  public onModuleDestroy(): void {
    if (this.ping !== undefined) clearInterval(this.ping);
    this.channel.complete();
  }

  /** Рассылает событие и кладёт его в кольцо, откуда его добирает вернувшийся клиент. */
  public publish(kind: LiveEventKind, keys: readonly string[], data: object): void {
    const event = this.ring.append(kind, keys, data);
    this.metrics.observeEvent(kind);
    this.channel.next(event);
  }

  public openStreams(): number {
    return this.streams;
  }

  public epoch(): number {
    return this.ring.currentEpoch;
  }

  /**
   * Поток одного соединения. Первым кадром идёт приветствие: до него заголовки в сокет
   * не уходят, а клиенту нужны и серверное время, и эпоха, чтобы понимать свои идентификаторы.
   */
  public stream(options: StreamOptions): Observable<MessageEvent> {
    const allowed = (event: LiveEvent): boolean => {
      const required = REQUIRED[event.kind];
      if (required !== null && !hasPermission(options.permissions, required)) return false;
      if (options.devices === null || event.keys.length === 0) return true;

      return event.keys.some(
        (key) => !key.startsWith('device:') || options.devices?.has(key.slice('device:'.length)),
      );
    };

    return new Observable<MessageEvent>((subscriber) => {
      this.streams += 1;
      this.metrics.setStreams(this.streams);

      subscriber.next({
        id: this.ring.currentId(),
        type: 'hello',
        data: {
          serverTime: toIsoTimestamp(this.clock.now()),
          epoch: this.ring.currentEpoch,
          pingMs: this.env.SSE_PING_MS,
        },
      });

      const backfill = this.ring.since(options.lastEventId);
      if (backfill.resync) {
        this.metrics.observeResync(backfill.reason ?? 'unknown');
        subscriber.next({
          id: this.ring.currentId(),
          type: 'resync',
          data: {
            reason: backfill.reason,
            serverTime: toIsoTimestamp(this.clock.now()),
          },
        });
      } else {
        for (const event of backfill.events) {
          if (allowed(event)) subscriber.next(toMessage(event));
        }
      }

      const subscription = this.channel.subscribe({
        next: (event) => {
          if (allowed(event)) subscriber.next(toMessage(event));
        },
        complete: () => {
          subscriber.complete();
        },
      });

      return () => {
        subscription.unsubscribe();
        this.streams -= 1;
        this.metrics.setStreams(this.streams);
      };
    });
  }
}
