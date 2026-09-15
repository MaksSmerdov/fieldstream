import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';
import type { ErrorKind } from '@fieldstream/contracts';
import { LATENCY_BUCKETS_MS } from '../polling/latency.js';

/** Метрики сборщика в формате Prometheus. */
export interface CollectorMetrics {
  readonly registry: Registry;
  readonly observePoll: (lineCode: string, errorKind: ErrorKind | null) => void;
  readonly observeRequest: (lineCode: string, durationMs: number) => void;
  readonly observeCycle: (lineCode: string, durationMs: number) => void;
  readonly observeWatchdogTrip: (lineCode: string) => void;
  readonly observeReconnect: (lineCode: string) => void;
  readonly setOpenBreakers: (lineCode: string, count: number) => void;
  readonly setBuffer: (size: number) => void;
  readonly setBufferAge: (ageMs: number) => void;
  readonly observeDropped: (count: number) => void;
}

/** Реестр метрик процесса: свои счётчики плюс стандартные метрики Node. */
export const createMetrics = (): CollectorMetrics => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const polls = new Counter({
    name: 'fieldstream_collector_polls_total',
    help: 'Обращения к приборам по исходу',
    labelNames: ['line', 'outcome'],
    registers: [registry],
  });
  const cycles = new Histogram({
    name: 'fieldstream_collector_cycle_duration_seconds',
    help: 'Длительность обхода линии',
    labelNames: ['line'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [registry],
  });
  const requests = new Histogram({
    name: 'fieldstream_collector_request_duration_seconds',
    help: 'Время ответа на успешный запрос к прибору',
    labelNames: ['line'],
    buckets: LATENCY_BUCKETS_MS.map((bound) => bound / 1000),
    registers: [registry],
  });
  const watchdogTrips = new Counter({
    name: 'fieldstream_collector_watchdog_trips_total',
    help: 'Срабатывания сторожа цикла: обход завис и был брошен',
    labelNames: ['line'],
    registers: [registry],
  });
  const reconnects = new Counter({
    name: 'fieldstream_collector_reconnects_total',
    help: 'Попытки переподключения к порту шлюза',
    labelNames: ['line'],
    registers: [registry],
  });
  const openBreakers = new Gauge({
    name: 'fieldstream_collector_open_breakers',
    help: 'Приборы линии, выведенные размыкателем на редкую пробу',
    labelNames: ['line'],
    registers: [registry],
  });
  const buffer = new Gauge({
    name: 'fieldstream_collector_buffer_size',
    help: 'Сообщения, ждущие отправки в Kafka',
    registers: [registry],
  });
  const bufferAge = new Gauge({
    name: 'fieldstream_collector_buffer_oldest_age_seconds',
    help: 'Возраст самого старого сообщения, ещё не принятого брокером',
    registers: [registry],
  });
  const dropped = new Counter({
    name: 'fieldstream_collector_buffer_dropped_total',
    help: 'Сообщения, отброшенные при переполнении буфера',
    registers: [registry],
  });

  return {
    registry,
    observePoll: (line, errorKind) => {
      polls.inc({ line, outcome: errorKind ?? 'ok' });
    },
    observeRequest: (line, durationMs) => {
      requests.observe({ line }, durationMs / 1000);
    },
    observeCycle: (line, durationMs) => {
      cycles.observe({ line }, durationMs / 1000);
    },
    observeWatchdogTrip: (line) => {
      watchdogTrips.inc({ line });
    },
    observeReconnect: (line) => {
      reconnects.inc({ line });
    },
    setOpenBreakers: (line, count) => {
      openBreakers.set({ line }, count);
    },
    setBuffer: (size) => {
      buffer.set(size);
    },
    setBufferAge: (ageMs) => {
      bufferAge.set(ageMs / 1000);
    },
    observeDropped: (count) => {
      dropped.inc(count);
    },
  };
};
