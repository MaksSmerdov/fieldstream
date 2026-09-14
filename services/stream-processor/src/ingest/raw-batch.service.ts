import { Inject, Injectable } from '@nestjs/common';
import type { EachBatchPayload, KafkaMessage } from 'kafkajs';
import type pg from 'pg';
import { TOPICS } from '@fieldstream/contracts';
import type { TelemetryReading } from '@fieldstream/contracts';
import {
  clearAlarmEvents,
  insertAlarmEvents,
  insertDeviceEvents,
  insertReadings,
  recordDlqMessages,
  withTransaction,
} from '@fieldstream/db';
import type { DeviceEventRow, DlqRow, OpenAlarmEpisode, ReadingRow } from '@fieldstream/db';
import { toIsoTimestamp } from '@fieldstream/domain';
import type {
  Clock,
  DeviceAlarmState,
  MetricAlarmState,
  SpikeFilterState,
} from '@fieldstream/domain';
import { commitThrough, decodeMessage, headerText, toDlqMessage } from '@fieldstream/kafka';
import type { RawOutgoingMessage } from '@fieldstream/kafka';
import type { Logger } from '@fieldstream/nest-common';
import { AlarmRulesService } from '../alarms/alarm-rules.service.js';
import { HealthService } from '../health/health.service.js';
import type { ProcessorMetrics } from '../metrics/metrics.js';
import { PRODUCER_NAME, ProducerService } from '../publish/producer.service.js';
import { DeviceRefsService } from '../topology/device-refs.service.js';
import { CLOCK, LOGGER, METRICS, POOL } from '../tokens.js';
import {
  alarmEventOf,
  clearedRowOf,
  evaluateFrameAlarms,
  raisedRowOf,
  toOutcome,
} from './alarms.js';
import type { AlarmOutcome } from './alarms.js';
import { INGEST_GROUP } from './assignment.js';
import { filterKey, processFrame } from './frame.js';

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [200, 500, 1_000, 2_500, 5_000] as const;

interface Poisoned {
  readonly message: KafkaMessage;
  readonly errorClass: string;
  readonly error: string;
}

/** Задержка перед повтором попытки номер attempt с джиттером, чтобы партиции не шли в ногу. */
const backoffMs = (attempt: number): number => {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] ?? 5_000;
  return Math.round(base * (0.9 + Math.random() * 0.2));
};

/** Заголовки строками для таблицы очереди недоставленных. */
const textHeaders = (message: KafkaMessage): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const name of Object.keys(message.headers ?? {})) {
    const value = headerText(message.headers, name);
    if (value !== null) headers[name] = value;
  }
  return headers;
};

/**
 * Обработчик пачек сырых кадров. Порядок строгий: разбор всей пачки, одна транзакция с показаниями
 * и событиями, отправка ядовитых сообщений в очередь недоставленных, публикация показаний,
 * и только потом подтверждение смещения. Падение между записью и подтверждением даёт повтор,
 * а повтор ничего не меняет: ключи идемпотентности лежат в схеме базы.
 * Фильтры скачков и алармы в памяти только по своим приборам: при ребалансе отобранные
 * забываются, а новые приходят вместе с открытыми эпизодами из базы.
 */
@Injectable()
export class RawBatchService {
  private readonly attempts = new Map<number, number>();
  private readonly owned = new Set<string>();
  private readonly filters = new Map<string, SpikeFilterState>();
  private readonly alarms = new Map<string, DeviceAlarmState>();

  public constructor(
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(METRICS) private readonly metrics: ProcessorMetrics,
    private readonly producer: ProducerService,
    private readonly refs: DeviceRefsService,
    private readonly rules: AlarmRulesService,
    private readonly health: HealthService,
  ) {}

  /** Забывает отобранные приборы: их фильтры и алармы теперь ведёт другой экземпляр. */
  public release(deviceCodes: readonly string[]): void {
    for (const deviceCode of deviceCodes) {
      this.owned.delete(deviceCode);
      this.forget(deviceCode);
    }
  }

  /**
   * Принимает новые приборы. Фильтры скачков начинаются с чистого листа, а поднятые эпизоды
   * возвращаются в память: иначе движок не знал бы, что эпизод открыт, и никогда бы его не снял,
   * а счётчик активных алармов на экранах врал бы до ручного вмешательства.
   */
  public adopt(deviceCodes: readonly string[], episodes: readonly OpenAlarmEpisode[]): void {
    const adopted = new Set(deviceCodes);
    const memory = new Map<string, Record<string, MetricAlarmState>>();

    for (const deviceCode of adopted) {
      this.owned.add(deviceCode);
      this.forget(deviceCode);
    }

    for (const episode of episodes) {
      if (!adopted.has(episode.deviceCode) || episode.threshold === null) continue;
      const device = memory.get(episode.deviceCode) ?? {};
      device[episode.metricKey] = {
        raised: true,
        boundary: episode.boundary,
        severity: episode.severity,
        threshold: episode.threshold,
        raisedAt: episode.raisedAtMs,
        mode: episode.mode,
      };
      memory.set(episode.deviceCode, device);
    }

    for (const [deviceCode, device] of memory) this.alarms.set(deviceCode, device);
  }

  public async handle(payload: EachBatchPayload): Promise<void> {
    const { batch } = payload;
    if (!this.refs.isLoaded()) {
      this.pauseFor(payload, 1, 'топология ещё не загружена');
      return;
    }

    const startedAt = this.clock.now();
    const filters = new Map(this.filters);
    const alarms = new Map(this.alarms);
    const touched = new Set<string>();
    const frames = this.health.draftFrames();
    const alarmOutcomes: AlarmOutcome[] = [];
    const rows: ReadingRow[] = [];
    const readings: TelemetryReading[] = [];
    const events: DeviceEventRow[] = [];
    const poisoned: Poisoned[] = [];
    let lastOffset: string | null = null;

    for (const message of batch.messages) {
      if (!payload.isRunning() || payload.isStale()) break;
      lastOffset = message.offset;

      const decoded = decodeMessage(TOPICS.telemetryRaw, message.value, message.headers);
      if (!decoded.ok) {
        poisoned.push({ message, errorClass: decoded.errorClass, error: decoded.error });
        continue;
      }

      const outcome = processFrame(decoded.payload, {
        refs: this.refs.current(),
        filters,
        source: { partition: batch.partition, offset: message.offset },
      });
      if (outcome.kind === 'rejected') {
        poisoned.push({ message, errorClass: outcome.errorClass, error: outcome.error });
        continue;
      }

      for (const [key, state] of outcome.filters) filters.set(key, state);
      touched.add(outcome.observation.deviceCode);
      rows.push(...outcome.rows);
      readings.push(outcome.reading);
      const deviceId = this.refs.current().get(outcome.observation.deviceCode)?.deviceId;
      if (deviceId !== undefined) {
        for (const event of frames.observe(outcome.observation)) {
          events.push({ deviceId, event });
        }

        const deviceCode = outcome.observation.deviceCode;
        const evaluated = evaluateFrameAlarms({
          observation: outcome.observation,
          rows: outcome.rows,
          rules: this.rules.forDevice(deviceCode),
          prevState: alarms.get(deviceCode) ?? {},
        });
        alarms.set(deviceCode, evaluated.state);
        for (const transition of evaluated.transitions) {
          alarmOutcomes.push(toOutcome(transition, deviceId, outcome.reading.traceId));
        }
      }
    }

    if (lastOffset === null) return;

    const failedAt = toIsoTimestamp(this.clock.now());
    const dlqMessages: RawOutgoingMessage[] = poisoned.map((item) =>
      toDlqMessage(
        TOPICS.telemetryRawDlq,
        {
          topic: batch.topic,
          partition: batch.partition,
          offset: item.message.offset,
          timestamp: item.message.timestamp,
          key: item.message.key,
          value: item.message.value,
          headers: item.message.headers,
        },
        {
          errorClass: item.errorClass,
          error: item.error,
          consumerGroup: INGEST_GROUP,
          attempt: 1,
          firstFailedAt: failedAt,
        },
        PRODUCER_NAME,
      ),
    );
    const dlqRows: DlqRow[] = poisoned.map((item) => ({
      sourceTopic: batch.topic,
      partition: batch.partition,
      offset: item.message.offset,
      key: item.message.key?.toString('utf8') ?? null,
      headers: textHeaders(item.message),
      payload: item.message.value,
      errorClass: item.errorClass,
      error: item.error,
    }));

    const raised = alarmOutcomes.filter((item) => item.transition.state === 'raised');
    const cleared = alarmOutcomes.filter((item) => item.transition.state === 'cleared');

    try {
      const inserted = await withTransaction(this.pool, async (client) => {
        const count = await insertReadings(client, rows);
        await insertDeviceEvents(client, events);
        await insertAlarmEvents(client, raised.map(raisedRowOf));
        await clearAlarmEvents(client, cleared.map(clearedRowOf));
        await recordDlqMessages(client, dlqRows);
        return count;
      });
      await this.producer.sendRaw(dlqMessages);
      await this.producer.send([
        ...readings.map((reading) =>
          this.producer.encode(TOPICS.telemetryReadings, reading, reading.traceId),
        ),
        ...alarmOutcomes.map((item) =>
          this.producer.encode(TOPICS.alarmEvents, alarmEventOf(item), item.traceId),
        ),
      ]);

      this.metrics.observeRows('readings', inserted);
      this.metrics.observeFrames('accepted', readings.length);
      if (raised.length > 0) this.metrics.observeAlarms('raised', raised.length);
      if (cleared.length > 0) this.metrics.observeAlarms('cleared', cleared.length);
      for (const item of poisoned) {
        this.metrics.observeDlq(item.errorClass);
        this.log.warn(
          {
            partition: batch.partition,
            offset: item.message.offset,
            errorClass: item.errorClass,
            error: item.error,
          },
          'кадр отправлен в очередь недоставленных',
        );
      }
    } catch (error) {
      this.metrics.observeTransient(batch.topic);
      const attempt = (this.attempts.get(batch.partition) ?? 0) + 1;
      this.attempts.set(batch.partition, attempt);

      if (attempt > MAX_ATTEMPTS) {
        this.log.fatal(
          { err: error, partition: batch.partition, attempts: attempt },
          'сбой не прошёл за пять попыток: процесс завершается, перезапуск за Docker',
        );
        process.exit(1);
      }
      this.pauseFor(payload, attempt, 'сбой записи или публикации', error);
      return;
    }

    this.attempts.delete(batch.partition);
    this.remember(filters, alarms, touched);
    frames.commit();
    await commitThrough(payload, lastOffset);
    await payload.heartbeat();
    this.metrics.observeBatch(batch.topic, this.clock.now() - startedAt);
  }

  /**
   * Переносит в память итог записанной пачки. Только по приборам из пачки и только если они
   * всё ещё свои: ребаланс посреди пачки не должен оживить отобранный прибор или затереть
   * эпизоды, восстановленные для нового.
   */
  private remember(
    filters: ReadonlyMap<string, SpikeFilterState>,
    alarms: ReadonlyMap<string, DeviceAlarmState>,
    touched: ReadonlySet<string>,
  ): void {
    for (const deviceCode of touched) {
      if (!this.owned.has(deviceCode)) continue;

      const prefix = filterKey(deviceCode, '');
      for (const [key, state] of filters) {
        if (key.startsWith(prefix)) this.filters.set(key, state);
      }
      const alarm = alarms.get(deviceCode);
      if (alarm !== undefined) this.alarms.set(deviceCode, alarm);
    }
  }

  /** Убирает из памяти фильтры скачков и алармы прибора. */
  private forget(deviceCode: string): void {
    this.alarms.delete(deviceCode);
    const prefix = filterKey(deviceCode, '');
    for (const key of [...this.filters.keys()]) {
      if (key.startsWith(prefix)) this.filters.delete(key);
    }
  }

  /** Пауза партиции без подтверждения смещения: после неё kafkajs отдаст ту же пачку заново. */
  private pauseFor(
    payload: EachBatchPayload,
    attempt: number,
    reason: string,
    error?: unknown,
  ): void {
    const delay = backoffMs(attempt);
    const resume = payload.pause();
    setTimeout(resume, delay).unref();
    this.log.warn(
      { err: error, partition: payload.batch.partition, attempt, delayMs: delay },
      `${reason}: партиция на паузе`,
    );
  }
}
