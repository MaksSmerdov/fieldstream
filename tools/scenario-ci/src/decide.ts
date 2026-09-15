import { FINISHED_SCENARIO_RUN_STATUSES } from '@fieldstream/contracts';
import type { ScenarioRun, ScenarioRunStatus, ScenariosResponse } from '@fieldstream/contracts';

/** Период опроса хода прогона. */
export const POLL_MS = 2_000;

/** Пауза перед повтором запуска, пока стенд занят другим прогоном. */
export const CONFLICT_RETRY_MS = 15_000;

/** Пауза перед повтором, когда шлюз не ответил или недоступен. */
export const TRANSIENT_RETRY_MS = 5_000;

/** Сколько ждать итога сверх предела сценария: уборка поломок и запись итога. */
export const RESULT_GRACE_MS = 120_000;

/** Запас на расхождение часов CI и шлюза при поиске своего прогона. */
export const CLOCK_SLACK_MS = 5_000;

/** start ждёт 202 на запуск, read ждёт 200 на чтение. */
export type RequestPhase = 'start' | 'read';

/**
 * Что известно о запросе: фаза, был ли вход заново, сколько уже ждём и ждать ли занятый стенд.
 * Занятый стенд не ждут, когда его держит прогон без итога.
 */
export interface RetryContext {
  readonly phase: RequestPhase;
  readonly reloggedIn: boolean;
  readonly elapsedMs: number;
  readonly limitMs: number;
  readonly waitConflicts: boolean;
}

export type Decision =
  | { readonly kind: 'accept' }
  | { readonly kind: 'relogin' }
  | { readonly kind: 'wait'; readonly ms: number; readonly reason: string }
  | { readonly kind: 'fail'; readonly reason: string };

const TRANSIENT_STATUSES = new Set([502, 503, 504]);

/** Миллисекунды в целые секунды. */
const seconds = (ms: number): number => Math.round(ms / 1000);

/** Повтор, если он укладывается в предел, иначе провал. */
const waitWithin = (ms: number, reason: string, context: RetryContext): Decision =>
  context.elapsedMs + ms <= context.limitMs
    ? { kind: 'wait', ms, reason }
    : { kind: 'fail', reason: `${reason} дольше ${seconds(context.limitMs)} с` };

/**
 * Что делать с ответом шлюза. status null значит, что ответа нет. Токен доступа живёт 10 минут,
 * поэтому 401 это вход заново, а второй 401 подряд уже провал. Занятый стенд ждётся только
 * при запуске прогона.
 */
export const decide = (status: number | null, context: RetryContext): Decision => {
  if (status === (context.phase === 'start' ? 202 : 200)) return { kind: 'accept' };

  if (status === 401) {
    return context.reloggedIn
      ? { kind: 'fail', reason: 'шлюз не принял токен сразу после входа' }
      : { kind: 'relogin' };
  }
  if (status === 409 && context.phase === 'start') {
    return context.waitConflicts
      ? waitWithin(CONFLICT_RETRY_MS, 'стенд занят другим прогоном', context)
      : { kind: 'fail', reason: 'стенд всё ещё занят прогоном без итога' };
  }
  if (isAmbiguous(status)) return waitWithin(TRANSIENT_RETRY_MS, 'шлюз недоступен', context);

  return { kind: 'fail', reason: `шлюз ответил ${status}` };
};

/** Ответа нет или шлюз недоступен: запрос мог дойти, а ответ потеряться. */
export const isAmbiguous = (status: number | null): boolean =>
  status === null || TRANSIENT_STATUSES.has(status);

/** Какой прогон искать: сценарий, учётка скрипта и не раньше какого момента по часам шлюза. */
export interface OwnRunQuery {
  readonly scenario: string;
  readonly email: string;
  readonly notBeforeMs: number;
}

/**
 * Идущий прогон, созданный этим же запуском из CI, ответ на который потерялся. Повторный
 * запуск получил бы 409 на собственный прогон, а потом прогнал бы сценарий второй раз.
 */
export const ownActiveRun = (listed: ScenariosResponse, query: OwnRunQuery): ScenarioRun | null => {
  const run = listed.activeRun;
  if (run === null) return null;

  const own =
    run.scenario === query.scenario &&
    run.source === 'ci' &&
    run.requestedBy.toLowerCase() === query.email.toLowerCase() &&
    Date.parse(run.createdAt) >= query.notBeforeMs;

  return own ? run : null;
};

/** Предел ожидания итога прогона. */
export const resultLimitMs = (timeoutSec: number): number => timeoutSec * 1000 + RESULT_GRACE_MS;

/** Прогон завершён и больше не изменится. */
export const isFinished = (status: ScenarioRunStatus): boolean =>
  FINISHED_SCENARIO_RUN_STATUSES.includes(status);

/** Текст ошибки из ответа шлюза: message строкой или списком. */
export const messageOf = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null || !('message' in body)) return null;

  const { message } = body;
  if (typeof message === 'string' && message.length > 0) return message;
  if (Array.isArray(message)) {
    const parts = message.filter((part): part is string => typeof part === 'string');
    return parts.length > 0 ? parts.join('; ') : null;
  }

  return null;
};
