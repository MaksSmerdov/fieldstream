import { TOPICS } from '@fieldstream/contracts';
import type { PipelineMember, PipelineTopic, TopicKey } from '@fieldstream/contracts';
import { spanText } from '../../shared/time/human-time.js';
import type { LagTrend } from './pipeline-geometry.js';

const GROUP_STATE_WORDS: Readonly<Record<string, string>> = {
  Stable: 'работает стабильно',
  Empty: 'участников нет',
  PreparingRebalance: 'готовит перераспределение',
  CompletingRebalance: 'завершает перераспределение',
  Dead: 'удалена',
  Unknown: 'состояние неизвестно',
};

/** Состояние группы словами: незнакомое показывается как есть. */
export const groupStateText = (state: string): string => GROUP_STATE_WORDS[state] ?? state;

/** Группа посреди перераспределения партиций. */
export const isRebalancingState = (state: string): boolean =>
  state === 'PreparingRebalance' || state === 'CompletingRebalance';

/** Цвет состояния группы. */
export const groupStateColor = (state: string): 'success' | 'warning' | 'error' | 'default' => {
  if (state === 'Stable') return 'success';
  if (isRebalancingState(state)) return 'warning';
  if (state === 'Dead') return 'error';

  return 'default';
};

const NUMBER = new Intl.NumberFormat('ru-RU');
const RATE = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

/** Число с разрядами. */
export const numberText = (value: number): string => NUMBER.format(value);

/** Темп числом: неизвестный темп это прочерк, а не ноль. */
export const rateValue = (rate: number | null): string => (rate === null ? '–' : RATE.format(rate));

/** Темп для подписи на схеме. */
export const rateText = (rate: number | null): string =>
  rate === null ? '–' : `${RATE.format(rate)}/с`;

/** Темп для вспомогательных программ. */
export const rateSpoken = (rate: number | null): string =>
  rate === null ? 'темп неизвестен' : `${RATE.format(rate)} в секунду`;

/** Оценка времени на разбор отставания. */
export const lagSecondsText = (totalLag: number, lagSeconds: number | null): string => {
  if (totalLag === 0) return 'отставания нет';
  if (lagSeconds === null) return 'оценки времени нет';
  if (lagSeconds < 1) return 'меньше секунды';

  return `примерно ${spanText(lagSeconds * 1000)}`;
};

export const CLEANUP_WORDS: Readonly<Record<PipelineTopic['cleanupPolicy'], string>> = {
  delete: 'удаление по сроку',
  compact: 'компакция по ключу',
};

const TOPIC_WORDS: Readonly<Record<TopicKey, string>> = {
  telemetryRaw: 'сырые кадры',
  pollCycles: 'циклы опроса',
  lineStatus: 'статус линий',
  telemetryReadings: 'показания',
  deviceState: 'состояние приборов',
  alarmEvents: 'события алармов',
  deviceCommands: 'команды',
  commandResults: 'результаты команд',
  telemetryRawDlq: 'недоставленные кадры',
};

const TOPIC_TITLES = new Map(
  (Object.keys(TOPIC_WORDS) as TopicKey[]).map((key) => [TOPICS[key].name, TOPIC_WORDS[key]]),
);

/** Человеческое имя топика: незнакомый показывается машинным именем. */
export const topicTitle = (name: string): string => TOPIC_TITLES.get(name) ?? name;

export const TREND_WORDS: Readonly<Record<LagTrend, string>> = {
  growing: 'растёт',
  shrinking: 'сокращается',
  steady: 'не растёт',
  unknown: 'мало снимков',
};

/** Имя участника: клиент может не назваться, тогда виден идентификатор. */
export const memberName = (member: PipelineMember): string =>
  member.clientId.length > 0 ? member.clientId : member.memberId;
