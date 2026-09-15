import type { ScenarioRun, ScenarioRunStep, ScenarioStepStatus } from '@fieldstream/contracts';

/** Итог сценария для журнала и сводки CI. */
export interface ScenarioOutcome {
  readonly name: string;
  readonly title: string;
  readonly passed: boolean;
  readonly durationMs: number | null;
  readonly error: string | null;
}

const STEP_WORDS: Readonly<Record<ScenarioStepStatus, string>> = {
  pending: 'ждёт',
  running: 'идёт',
  passed: 'пройден',
  failed: 'провален',
  skipped: 'пропущен',
};

/** Длительность человеческими словами: 42 с, 3 мин 12 с. Неизвестная это прочерк. */
export const formatDuration = (ms: number | null): string => {
  if (ms === null) return '-';

  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;

  return minutes === 0 ? `${rest} с` : `${minutes} мин ${rest} с`;
};

/** Длительность прогона по его отметкам начала и конца. */
export const durationMsOf = (run: Pick<ScenarioRun, 'startedAt' | 'finishedAt'>): number | null =>
  run.startedAt === null || run.finishedAt === null
    ? null
    : Date.parse(run.finishedAt) - Date.parse(run.startedAt);

/** Шаги, чей статус изменился с прошлого опроса. Ожидающие шаги в журнал не идут. */
export const changedSteps = (
  seen: ReadonlyMap<number, ScenarioStepStatus>,
  steps: readonly ScenarioRunStep[],
): ScenarioRunStep[] =>
  steps.filter((step) => step.status !== 'pending' && seen.get(step.index) !== step.status);

/** Строка журнала о шаге: номер, статус, заголовок и что увидели. */
export const stepLine = (scenario: string, step: ScenarioRunStep, total: number): string => {
  const detail = step.status === 'running' || step.detail === null ? '' : ` (${step.detail})`;
  return `${scenario}, шаг ${step.index + 1} из ${total}, ${STEP_WORDS[step.status]}: ${step.title}${detail}`;
};

/** Итоговая строка сценария в журнале. */
export const outcomeLine = (outcome: ScenarioOutcome): string => {
  const duration = outcome.durationMs === null ? '' : ` за ${formatDuration(outcome.durationMs)}`;
  if (outcome.passed) return `${outcome.name}: прошёл${duration}`;

  return `${outcome.name}: не прошёл${duration}: ${outcome.error ?? 'причина не указана'}`;
};

/** Текст ячейки таблицы Markdown: без переводов строк и с экранированной чертой. */
const cell = (text: string): string => text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

/**
 * Сводка прогона сценариев таблицей Markdown для журнала и страницы задачи CI. fatal это
 * причина, по которой прогон сценариев оборвался целиком.
 */
export const formatSummary = (
  outcomes: readonly ScenarioOutcome[],
  fatal: string | null = null,
): string => {
  const passed = outcomes.filter((outcome) => outcome.passed).length;
  const rows = outcomes.map(
    (outcome) =>
      `| \`${outcome.name}\` ${cell(outcome.title)} | ${outcome.passed ? 'прошёл' : 'не прошёл'} | ${formatDuration(outcome.durationMs)} | ${cell(outcome.error ?? '')} |`,
  );
  const table =
    rows.length === 0
      ? []
      : [
          '| Сценарий | Итог | Длительность | Подробности |',
          '| --- | --- | --- | --- |',
          ...rows,
          '',
        ];
  const failure = fatal === null ? [] : [`Прогон сценариев оборвался: ${cell(fatal)}`, ''];

  return [
    '### Сценарии стенда',
    '',
    ...table,
    ...failure,
    `Прошли ${passed} из ${outcomes.length}.`,
  ].join('\n');
};
