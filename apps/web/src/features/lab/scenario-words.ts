import { FINISHED_SCENARIO_RUN_STATUSES } from '@fieldstream/contracts';
import type {
  ScenarioRun,
  ScenarioRunSource,
  ScenarioRunStatus,
  ScenarioStepStatus,
} from '@fieldstream/contracts';
import { counted } from '../../shared/text/plural.js';

export const RUN_STATUS_TEXT: Readonly<Record<ScenarioRunStatus, string>> = {
  queued: 'в очереди',
  running: 'идёт',
  passed: 'прошёл',
  failed: 'провален',
};

export const RUN_STATUS_COLOR: Readonly<
  Record<ScenarioRunStatus, 'default' | 'primary' | 'success' | 'error'>
> = {
  queued: 'default',
  running: 'primary',
  passed: 'success',
  failed: 'error',
};

export const STEP_STATUS_TEXT: Readonly<Record<ScenarioStepStatus, string>> = {
  pending: 'ждёт',
  running: 'идёт',
  passed: 'пройден',
  failed: 'провален',
  skipped: 'пропущен',
};

export const SOURCE_TEXT: Readonly<Record<ScenarioRunSource, string>> = {
  ui: 'из интерфейса',
  ci: 'из CI',
};

const MINUTE_GENITIVE_FORMS: readonly [string, string, string] = ['минуты', 'минут', 'минут'];

/** Итог прогона известен, ход больше не меняется. */
export const isRunFinished = (run: ScenarioRun): boolean =>
  FINISHED_SCENARIO_RUN_STATUSES.includes(run.status);

/** Предел длительности сценария словами, например «до 6 минут». */
export const limitText = (timeoutSec: number): string =>
  `до ${counted(Math.ceil(timeoutSec / 60), MINUTE_GENITIVE_FORMS)}`;

/** Прошедшее время минутами и секундами, например 1:05. */
export const elapsedText = (ms: number): string => {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

/** Момент прогона для бейджа: итог, начало или постановка в очередь. */
export const runMoment = (run: ScenarioRun): string =>
  run.finishedAt ?? run.startedAt ?? run.createdAt;

/** Длительность прогона по серверным часам: у идущего до текущего момента. */
export const runElapsedMs = (run: ScenarioRun, nowMs: number): number => {
  const startMs = Date.parse(run.startedAt ?? run.createdAt);
  const endMs = run.finishedAt === null ? nowMs : Date.parse(run.finishedAt);

  return Math.max(0, endMs - startMs);
};
