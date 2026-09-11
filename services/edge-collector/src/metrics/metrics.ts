import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';
import type { ErrorKind } from '@fieldstream/contracts';

/** Метрики сборщика в формате Prometheus. */
export interface CollectorMetrics {
  readonly registry: Registry;
  readonly observePoll: (lineCode: string, errorKind: ErrorKind | null) => void;
  readonly observeCycle: (lineCode: string, durationMs: number) => void;
  readonly observeReconnect: (lineCode: string) => void;
  readonly setOpenBreakers: (lineCode: string, count: number) => void;
  readonly setBuffer: (size: number) => void;
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
    observeCycle: (line, durationMs) => {
      cycles.observe({ line }, durationMs / 1000);
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
    observeDropped: (count) => {
      dropped.inc(count);
    },
  };
};
