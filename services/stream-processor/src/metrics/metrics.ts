import { Counter, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

/** Метрики процессора в формате Prometheus. */
export interface ProcessorMetrics {
  readonly registry: Registry;
  readonly observeFrames: (outcome: string, count: number) => void;
  readonly observeRows: (table: string, count: number) => void;
  readonly observeDlq: (errorClass: string) => void;
  readonly observeAlarms: (state: string, count: number) => void;
  readonly observeBatch: (topic: string, durationMs: number) => void;
  readonly observeTransient: (topic: string) => void;
  readonly observeReplay: (outcome: string) => void;
}

/** Реестр метрик процесса: свои счётчики плюс стандартные метрики Node. */
export const createMetrics = (): ProcessorMetrics => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const frames = new Counter({
    name: 'fieldstream_processor_frames_total',
    help: 'Сырые кадры по исходу обработки',
    labelNames: ['outcome'],
    registers: [registry],
  });
  const rows = new Counter({
    name: 'fieldstream_processor_rows_written_total',
    help: 'Строки, реально вставленные в таблицы телеметрии',
    labelNames: ['table'],
    registers: [registry],
  });
  const dlq = new Counter({
    name: 'fieldstream_processor_dlq_total',
    help: 'Сообщения, отправленные в очередь недоставленных',
    labelNames: ['error_class'],
    registers: [registry],
  });
  const alarms = new Counter({
    name: 'fieldstream_processor_alarms_total',
    help: 'Переходы алармов по виду перехода',
    labelNames: ['state'],
    registers: [registry],
  });
  const batches = new Histogram({
    name: 'fieldstream_processor_batch_duration_seconds',
    help: 'Длительность обработки пачки от разбора до подтверждения смещения',
    labelNames: ['topic'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });
  const transient = new Counter({
    name: 'fieldstream_processor_transient_errors_total',
    help: 'Временные сбои записи или публикации: партиция встаёт на паузу без подтверждения',
    labelNames: ['topic'],
    registers: [registry],
  });
  const replays = new Counter({
    name: 'fieldstream_processor_replay_runs_total',
    help: 'Перепрогоны уставок по исходу: выполнен, провален или отобран другим экземпляром',
    labelNames: ['outcome'],
    registers: [registry],
  });

  return {
    registry,
    observeFrames: (outcome, count) => {
      frames.inc({ outcome }, count);
    },
    observeRows: (table, count) => {
      rows.inc({ table }, count);
    },
    observeDlq: (errorClass) => {
      dlq.inc({ error_class: errorClass });
    },
    observeAlarms: (state, count) => {
      alarms.inc({ state }, count);
    },
    observeBatch: (topic, durationMs) => {
      batches.observe({ topic }, durationMs / 1000);
    },
    observeTransient: (topic) => {
      transient.inc({ topic });
    },
    observeReplay: (outcome) => {
      replays.inc({ outcome });
    },
  };
};
