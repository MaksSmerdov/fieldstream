import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

/** Метрики шлюза в формате Prometheus. */
export interface GatewayMetrics {
  readonly registry: Registry;
  readonly observeRequest: (route: string, status: number, durationMs: number) => void;
  readonly setStreams: (count: number) => void;
  readonly observeEvent: (kind: string) => void;
  readonly observeResync: (reason: string) => void;
}

/** Реестр метрик процесса: свои счётчики плюс стандартные метрики Node. */
export const createMetrics = (): GatewayMetrics => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const requests = new Histogram({
    name: 'fieldstream_gateway_request_duration_seconds',
    help: 'Длительность обработки запроса по маршруту и коду ответа',
    labelNames: ['route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });
  const streams = new Gauge({
    name: 'fieldstream_gateway_event_streams',
    help: 'Открытые соединения живого канала',
    registers: [registry],
  });
  const events = new Counter({
    name: 'fieldstream_gateway_events_total',
    help: 'События, разосланные в живой канал, по виду',
    labelNames: ['kind'],
    registers: [registry],
  });
  const resyncs = new Counter({
    name: 'fieldstream_gateway_resync_total',
    help: 'Отправленные требования полной перезагрузки данных',
    labelNames: ['reason'],
    registers: [registry],
  });

  return {
    registry,
    observeRequest: (route, status, durationMs) => {
      requests.observe({ route, status }, durationMs / 1000);
    },
    setStreams: (count) => {
      streams.set(count);
    },
    observeEvent: (kind) => {
      events.inc({ kind });
    },
    observeResync: (reason) => {
      resyncs.inc({ reason });
    },
  };
};
