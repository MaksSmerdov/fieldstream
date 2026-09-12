import { Inject, Injectable } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import type { Consumer, EachMessagePayload } from 'kafkajs';
import { TOPICS } from '@fieldstream/contracts';
import type { AlarmEvent, DeviceState, TelemetryReading } from '@fieldstream/contracts';
import type { Clock } from '@fieldstream/domain';
import { createConsumer, createKafkaClient, decodeMessage } from '@fieldstream/kafka';
import { createThrottledLog } from '@fieldstream/nest-common';
import type { Logger } from '@fieldstream/nest-common';
import type { Env } from '../config/env.js';
import { DeviceRefsService } from '../topology/device-refs.service.js';
import { CLOCK, ENV, INSTANCE_ID, LOGGER } from '../tokens.js';
import { LiveBusService } from './live-bus.service.js';

/** Не чаще одного показания в секунду на прибор: экрану этого хватает, каналу заметно легче. */
const READING_THROTTLE_MS = 1_000;

/**
 * Мост из брокера в живой канал. Группа своя у каждого экземпляра шлюза: здесь нужен веер,
 * а не разделение работы, иначе при двух экземплярах половина событий уходила бы мимо вкладки.
 * Смещения одноразовые, историю канал не восстанавливает: за ней есть база.
 */
@Injectable()
export class KafkaBridgeService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly consumer: Consumer;
  private readonly lastReadingAt = new Map<string, number>();
  private running = false;

  public constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(INSTANCE_ID) instanceId: string,
    private readonly bus: LiveBusService,
    private readonly refs: DeviceRefsService,
  ) {
    const kafka = createKafkaClient({
      clientId: `${env.KAFKA_CLIENT_ID}-${instanceId}`,
      brokers: env.KAFKA_BROKERS,
      log: createThrottledLog(log, clock),
    });
    this.consumer = createConsumer(kafka, `fs-api-${instanceId}`);
  }

  public onApplicationBootstrap(): void {
    if (this.env.SSE_BRIDGE === 'off') {
      this.running = true;
      this.log.info({}, 'мост живого канала выключен: события из брокера не читаются');
      return;
    }

    void this.start();
  }

  public async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    if (this.env.SSE_BRIDGE === 'off') return;
    await this.consumer.disconnect();
  }

  public isRunning(): boolean {
    return this.running;
  }

  private async start(): Promise<void> {
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({
        topics: [TOPICS.telemetryReadings.name, TOPICS.deviceState.name, TOPICS.alarmEvents.name],
        fromBeginning: false,
      });
      await this.consumer.run({ eachMessage: (payload) => this.handle(payload) });
      this.running = true;
      this.log.info({ group: `fs-api` }, 'живой канал подключён к брокеру');
    } catch (error) {
      this.log.warn(
        { err: error },
        'мост живого канала не поднялся, повтор через несколько секунд',
      );
      setTimeout(() => {
        void this.start();
      }, 5_000).unref();
    }
  }

  private async handle(payload: EachMessagePayload): Promise<void> {
    const { topic, message } = payload;

    if (topic === TOPICS.telemetryReadings.name) {
      const decoded = decodeMessage(TOPICS.telemetryReadings, message.value, message.headers);
      if (decoded.ok) this.onReading(decoded.payload);
      return;
    }

    if (topic === TOPICS.deviceState.name) {
      const decoded = decodeMessage(TOPICS.deviceState, message.value, message.headers);
      if (decoded.ok) this.onState(decoded.payload);
      return;
    }

    if (topic === TOPICS.alarmEvents.name) {
      const decoded = decodeMessage(TOPICS.alarmEvents, message.value, message.headers);
      if (decoded.ok) this.onAlarm(decoded.payload);
    }

    return Promise.resolve();
  }

  /**
   * Ключи события: сам прибор, его линия и площадка. Вкладка обзора подписывается на площадку
   * и не перечисляет двадцать четыре кода, вкладка прибора берёт только свой.
   */
  private keysOf(deviceCode: string): string[] {
    const ref = this.refs.current().get(deviceCode);
    const keys = [`device:${deviceCode}`];
    if (ref !== undefined) keys.push(`line:${ref.lineCode}`, `site:${ref.siteCode}`);

    return keys;
  }

  private onReading(reading: TelemetryReading): void {
    const nowMs = this.clock.now();
    const last = this.lastReadingAt.get(reading.deviceCode) ?? 0;
    if (nowMs - last < READING_THROTTLE_MS) return;
    this.lastReadingAt.set(reading.deviceCode, nowMs);

    this.bus.publish('reading', this.keysOf(reading.deviceCode), {
      deviceCode: reading.deviceCode,
      ts: reading.ts,
      mode: reading.mode,
      quality: reading.quality,
      metrics: reading.metrics,
    });
  }

  private onState(state: DeviceState): void {
    this.bus.publish('device-state', this.keysOf(state.deviceCode), {
      deviceCode: state.deviceCode,
      status: state.status,
      reason: state.reason,
      mode: state.mode,
      since: state.since,
      lastOkAt: state.lastOkAt,
      consecutiveErrors: state.consecutiveErrors,
    });
  }

  private onAlarm(alarm: AlarmEvent): void {
    this.bus.publish('alarm', this.keysOf(alarm.deviceCode), {
      alarmId: alarm.alarmId,
      dedupeKey: alarm.dedupeKey,
      deviceCode: alarm.deviceCode,
      metricKey: alarm.metricKey,
      mode: alarm.mode,
      state: alarm.state,
      severity: alarm.severity,
      value: alarm.value,
      threshold: alarm.threshold,
      boundary: alarm.boundary,
      occurredAt: alarm.occurredAt,
    });
  }
}
