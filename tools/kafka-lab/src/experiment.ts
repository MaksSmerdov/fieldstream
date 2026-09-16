import type { Admin, Consumer, ConsumerConfig, Kafka, Producer, ProducerConfig } from 'kafkajs';

/** Имена опытов: имя команды запуска, оно же часть имени учебных топиков и групп. */
export const EXPERIMENT_NAMES = [
  'order',
  'groups',
  'rebalance',
  'commits',
  'idempotency',
  'dlq',
  'lag',
  'compaction',
] as const;

export type ExperimentName = (typeof EXPERIMENT_NAMES)[number];

/** Имя из аргументов запуска это имя опыта из реестра. */
export const isExperimentName = (value: string): value is ExperimentName =>
  (EXPERIMENT_NAMES as readonly string[]).includes(value);

/** Настройки учебного топика: остальное берётся из умолчаний брокера. */
export interface LabTopicOptions {
  readonly partitions?: number;
  readonly cleanupPolicy?: 'delete' | 'compact';
  readonly configs?: Readonly<Record<string, string>>;
}

/** Пределы ожидания: сколько ждать всего и как часто перепроверять. */
export interface WaitOptions {
  readonly limitMs?: number;
  readonly stepMs?: number;
}

/** Секундомер: сколько прошло с его создания, числом и человеческой строкой. */
export interface LabTimer {
  readonly ms: () => number;
  readonly text: () => string;
}

/**
 * Средства опыта. Учебные топики и группы заводятся только через topic и groupId: имена получают
 * префикс fieldstream.lab.<опыт>., а заведённое встаёт в очередь на уборку в конце прогона.
 * Боевые топики стенда разрешено только читать: писать в них и трогать их группы нельзя.
 */
export interface Lab {
  readonly name: ExperimentName;
  readonly brokers: readonly string[];
  readonly args: readonly string[];
  readonly kafka: Kafka;
  readonly admin: Admin;
  readonly topic: (suffix: string, options?: LabTopicOptions) => Promise<string>;
  readonly groupId: (suffix: string) => string;
  readonly producer: (overrides?: Partial<ProducerConfig>) => Promise<Producer>;
  readonly consumer: (
    groupSuffix: string,
    overrides?: Partial<Omit<ConsumerConfig, 'groupId'>>,
  ) => Promise<Consumer>;
  readonly waitFor: (
    what: string,
    ready: () => boolean | Promise<boolean>,
    options?: WaitOptions,
  ) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly timer: () => LabTimer;
  readonly step: (text: string) => void;
  readonly observe: (text: string) => void;
  readonly note: (text: string) => void;
  readonly conclude: (text: string) => void;
}

/** Опыт лаборатории: имя команды, что опыт показывает, и сам прогон. */
export interface Experiment {
  readonly name: ExperimentName;
  readonly title: string;
  readonly run: (lab: Lab) => Promise<void>;
}
