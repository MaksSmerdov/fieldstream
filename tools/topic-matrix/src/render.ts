import { fileURLToPath } from 'node:url';

/** Часть описания топика, нужная, чтобы создать его в брокере. */
export interface TopicShape {
  readonly name: string;
  readonly partitions: number;
  readonly cleanupPolicy: 'delete' | 'compact';
  readonly retentionMs: number | null;
  readonly configs?: Readonly<Record<string, string>>;
}

export const TOPICS_CONF_PATH = fileURLToPath(
  new URL('../../../infra/kafka/topics.conf', import.meta.url),
);

const HEADER = [
  '# Сгенерировано из packages/contracts/src/kafka/topics.manifest.ts командой pnpm topics:gen.',
  '# Руками не править: тест сверяет файл с манифестом.',
  '# имя партиции настройки',
];

/** Настройки топика для kafka-topics.sh: политика очистки, срок хранения и остальное из манифеста. */
const topicConfigs = (topic: TopicShape): string[] => [
  `cleanup.policy=${topic.cleanupPolicy}`,
  ...(topic.retentionMs === null ? [] : [`retention.ms=${String(topic.retentionMs)}`]),
  ...Object.entries(topic.configs ?? {}).map(([key, value]) => `${key}=${value}`),
];

/** Файл для kafka-init: по строке на топик, настройки через запятую. */
export const renderTopicsConf = (topics: readonly TopicShape[]): string =>
  [
    ...HEADER,
    ...topics.map(
      (topic) => `${topic.name} ${String(topic.partitions)} ${topicConfigs(topic).join(',')}`,
    ),
    '',
  ].join('\n');
