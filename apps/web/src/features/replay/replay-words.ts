import { FINISHED_REPLAY_RUN_STATUSES } from '@fieldstream/contracts';
import type {
  ReplayChangedRule,
  ReplayPatch,
  ReplayProgress,
  ReplayRuleValues,
  ReplayRun,
  ReplayRunStatus,
} from '@fieldstream/contracts';
import { counted } from '../../shared/text/plural.js';
import { spanText } from '../../shared/time/human-time.js';
import { MODE_LABEL } from '../device/mode-view.js';

export const REPLAY_STATUS_TEXT: Readonly<Record<ReplayRunStatus, string>> = {
  queued: 'в очереди',
  running: 'идёт',
  done: 'готово',
  failed: 'не выполнен',
};

/** Статус целой фразой для программ чтения с экрана: подписи чипа в неё не ложатся по роду. */
export const REPLAY_STATUS_PHRASE: Readonly<Record<ReplayRunStatus, string>> = {
  queued: 'Перепрогон в очереди',
  running: 'Перепрогон идёт',
  done: 'Перепрогон готов',
  failed: 'Перепрогон не выполнен',
};

export const REPLAY_STATUS_COLOR: Readonly<
  Record<ReplayRunStatus, 'default' | 'primary' | 'success' | 'error'>
> = {
  queued: 'default',
  running: 'primary',
  done: 'success',
  failed: 'error',
};

/** Сколько прогон может ждать процессор, прежде чем ожидание надо объяснить словами. */
export const QUEUE_HINT_MS = 5_000;

/** Насколько первый и последний кадр могут отстоять от краёв окна без оговорки: такт опроса линии. */
export const COVERAGE_SLACK_MS = 30_000;

export const DEVICE_FORMS: readonly [string, string, string] = ['прибор', 'прибора', 'приборов'];
export const PATCH_FORMS: readonly [string, string, string] = ['правка', 'правки', 'правок'];
export const EPISODE_FORMS: readonly [string, string, string] = ['эпизод', 'эпизода', 'эпизодов'];
const CYCLE_FORMS: readonly [string, string, string] = ['цикл', 'цикла', 'циклов'];

/** Итог прогона известен, ход больше не меняется. */
export const isReplayFinished = (run: ReplayRun): boolean =>
  FINISHED_REPLAY_RUN_STATUSES.includes(run.status);

/** Прогон завершился, но в окне не нашлось ни одного смещения сырого топика. */
export const isEmptyWindow = (run: ReplayRun): boolean =>
  run.status === 'done' && run.progress.offsetsTotal === 0;

/** Доля прочитанных смещений в процентах, не больше ста; null, пока объём окна неизвестен. */
export const progressPercent = (progress: ReplayProgress): number | null => {
  if (progress.offsetsTotal <= 0) return null;

  return Math.min(100, Math.floor((progress.offsetsDone / progress.offsetsTotal) * 100));
};

const NUMBER = new Intl.NumberFormat('ru-RU');

/** Число с разрядами. */
export const numberText = (value: number): string => NUMBER.format(value);

const MOMENT = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const CLOCK = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const CLOCK_SECONDS = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Окно прогона словами: границы по часам вкладки и длительность. */
export const windowText = (from: string, to: string): string => {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const sameDay = new Date(fromMs).toDateString() === new Date(toMs).toDateString();
  const end = sameDay ? CLOCK.format(new Date(toMs)) : MOMENT.format(new Date(toMs));

  return `${MOMENT.format(new Date(fromMs))}–${end} (${spanText(toMs - fromMs)})`;
};

/** Момент по часам вкладки с секундами: для строки покрытия. */
export const clockText = (iso: string): string => CLOCK_SECONDS.format(new Date(Date.parse(iso)));

/** Кадры начинаются позже начала окна или кончаются раньше его конца. */
export const coverageGap = (run: ReplayRun): { late: boolean; early: boolean } => {
  if (run.coveredFrom === null || run.coveredTo === null) return { late: false, early: false };

  return {
    late: Date.parse(run.coveredFrom) - Date.parse(run.from) > COVERAGE_SLACK_MS,
    early: Date.parse(run.to) - Date.parse(run.coveredTo) > COVERAGE_SLACK_MS,
  };
};

/** Прошедшее время минутами и секундами, например 1:05. */
export const elapsedText = (ms: number): string => {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;

  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
};

/** Длительность прогона по серверным часам: у идущего до текущего момента. */
export const runElapsedMs = (run: ReplayRun, nowMs: number): number => {
  const startMs = Date.parse(run.startedAt ?? run.createdAt);
  const endMs = run.finishedAt === null ? nowMs : Date.parse(run.finishedAt);

  return Math.max(0, endMs - startMs);
};

/** Граница словами: снятая граница это не ноль. */
const boundText = (value: number | null): string => (value === null ? 'снята' : String(value));

/** Правка словами: подпись параметра, режим и только меняющиеся поля. */
export const patchText = (patch: ReplayPatch, labelOf: (metricKey: string) => string): string => {
  const fields = [
    patch.minValue === undefined ? null : `нижняя граница ${boundText(patch.minValue)}`,
    patch.maxValue === undefined ? null : `верхняя граница ${boundText(patch.maxValue)}`,
    patch.hysteresis === undefined ? null : `гистерезис ${String(patch.hysteresis)}`,
    patch.debounceCycles === undefined
      ? null
      : `выдержка ${counted(patch.debounceCycles, CYCLE_FORMS)}`,
    patch.enabled === undefined ? null : patch.enabled ? 'включена' : 'выключена',
  ].filter((field): field is string => field !== null);

  return `${labelOf(patch.metricKey)}, ${MODE_LABEL[patch.mode]}: ${fields.join(', ')}`;
};

const RULE_FIELDS: readonly {
  readonly key: keyof ReplayRuleValues;
  readonly label: string;
}[] = [
  { key: 'minValue', label: 'нижняя граница' },
  { key: 'maxValue', label: 'верхняя граница' },
  { key: 'hysteresis', label: 'гистерезис' },
  { key: 'debounceCycles', label: 'выдержка, циклов' },
  { key: 'enabled', label: 'включена' },
];

/** Значение поля уставки словами. */
const ruleValueText = (value: ReplayRuleValues[keyof ReplayRuleValues]): string => {
  if (value === null) return 'нет';
  if (typeof value === 'boolean') return value ? 'да' : 'нет';

  return String(value);
};

/** Что правка изменила в уставке: «верхняя граница 12 → 8». */
export const ruleChangeText = (rule: ReplayChangedRule): string =>
  RULE_FIELDS.filter((field) => rule.baseline[field.key] !== rule.patched[field.key])
    .map(
      (field) =>
        `${field.label} ${ruleValueText(rule.baseline[field.key])} → ${ruleValueText(rule.patched[field.key])}`,
    )
    .join(', ');
