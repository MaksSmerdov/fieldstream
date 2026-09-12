import { Inject, Injectable } from '@nestjs/common';
import type { MessageEvent, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import type { Clock } from '@fieldstream/domain';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Env } from '../config/env.js';
import type { GatewayMetrics } from '../metrics/metrics.js';
import { CLOCK, ENV, METRICS } from '../tokens.js';

/**
 * Шина живого канала. Одно соединение на вкладку: подписчики получают общий поток,
 * поэтому число открытых потоков не зависит от числа приборов на экране.
 */
@Injectable()
export class LiveBusService implements OnModuleInit, OnModuleDestroy {
  private readonly channel = new Subject<MessageEvent>();
  private ping: NodeJS.Timeout | undefined;
  private streams = 0;

  public constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(METRICS) private readonly metrics: GatewayMetrics,
  ) {}

  public onModuleInit(): void {
    this.ping = setInterval(() => {
      this.publish('ping', { at: toIsoTimestamp(this.clock.now()) });
    }, this.env.SSE_PING_MS);
    this.ping.unref();
  }

  public onModuleDestroy(): void {
    if (this.ping !== undefined) clearInterval(this.ping);
    this.channel.complete();
  }

  /** Рассылает событие всем открытым соединениям. */
  public publish(kind: string, data: object): void {
    this.metrics.observeEvent(kind);
    this.channel.next({ type: kind, data });
  }

  public openStreams(): number {
    return this.streams;
  }

  /**
   * Поток одного соединения. Первым кадром уходит приветствие: до него заголовки ответа
   * в сокет не попадут, а клиенту нужны и серверное время, и период тишины.
   */
  public stream(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      this.streams += 1;
      this.metrics.setStreams(this.streams);
      subscriber.next({
        type: 'hello',
        data: { serverTime: toIsoTimestamp(this.clock.now()), pingMs: this.env.SSE_PING_MS },
      });
      const subscription = this.channel.subscribe(subscriber);

      return () => {
        subscription.unsubscribe();
        this.streams -= 1;
        this.metrics.setStreams(this.streams);
      };
    });
  }
}
