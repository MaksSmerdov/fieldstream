import type { ZodError, ZodErrorMap, ZodIssueOptionalMessage } from 'zod';
import {
  REPLAY_KEPT_RUNS,
  REPLAY_PATCH_FIELDS,
  REPLAY_RETENTION_MS,
  alarmRuleSchema,
  replayRulesSnapshotSchema,
} from '@fieldstream/contracts';
import type {
  AlarmRule,
  DeviceMode,
  ReplayChangedRule,
  ReplayDiffRow,
  ReplayPatch,
  ReplayRequest,
  ReplayRuleValues,
  ReplayRun,
  ReplayRulesSnapshot,
  ReplayVariant,
} from '@fieldstream/contracts';
import type {
  LiveAlarmEpisodeCount,
  LiveAlarmEpisodeWindow,
  ReplayEpisodeSummaryRow,
  ReplayRunRules,
} from '@fieldstream/db';
import { toIsoTimestamp } from '@fieldstream/domain';

/**
 * Допуск на расхождение часов и задержку отправки формы: конец окна может быть чуть позже
 * серверного «сейчас», а начало чуть раньше границы срока хранения.
 */
export const REPLAY_FUTURE_SLACK_MS = 60_000;

/** Последние прогоны в списке: столько же завершённых хранит процессор. */
export const REPLAY_RECENT_RUNS = REPLAY_KEPT_RUNS;

/** Ключ уставки и строки разницы: прибор, метрика, режим. */
interface RuleKey {
  readonly deviceCode: string;
  readonly metricKey: string;
  readonly mode: DeviceMode;
}

const keyOf = (key: RuleKey): string => `${key.deviceCode}/${key.metricKey}/${key.mode}`;

const compareKeys = (a: RuleKey, b: RuleKey): number =>
  a.deviceCode.localeCompare(b.deviceCode) ||
  a.metricKey.localeCompare(b.metricKey) ||
  a.mode.localeCompare(b.mode);

/** Итог применения правок: уставки варианта «стало» или причины отказа. */
export type PatchOutcome =
  | { readonly ok: true; readonly rules: AlarmRule[] }
  | { readonly ok: false; readonly issues: string[] };

const TYPE_NAMES: Readonly<Record<string, string>> = {
  string: 'строка',
  number: 'число',
  integer: 'целое число',
  boolean: 'true или false',
  array: 'список',
  object: 'объект',
};

/** Русский текст стандартной проверки zod или null, если своего текста для неё нет. */
const standardText = (issue: ZodIssueOptionalMessage): string | null => {
  switch (issue.code) {
    case 'invalid_type':
      return issue.received === 'undefined'
        ? 'обязательное поле'
        : `ожидается ${TYPE_NAMES[issue.expected] ?? issue.expected}`;
    case 'too_small':
      if (issue.type === 'number') {
        return `${issue.inclusive ? 'не меньше' : 'больше'} ${String(issue.minimum)}`;
      }
      if (issue.type === 'array') return `элементов не меньше ${String(issue.minimum)}`;
      if (issue.type === 'string') return `длина не меньше ${String(issue.minimum)}`;
      return null;
    case 'too_big':
      if (issue.type === 'number') {
        return `${issue.inclusive ? 'не больше' : 'меньше'} ${String(issue.maximum)}`;
      }
      if (issue.type === 'array') return `элементов не больше ${String(issue.maximum)}`;
      if (issue.type === 'string') return `длина не больше ${String(issue.maximum)}`;
      return null;
    case 'invalid_enum_value':
      return `допустимо ${issue.options.map(String).join(', ')}`;
    case 'invalid_string':
      if (issue.validation === 'datetime') {
        return 'ожидается время ISO 8601, например 2026-09-15T10:00:00.000Z';
      }
      return issue.validation === 'uuid' ? 'ожидается uuid' : null;
    case 'unrecognized_keys':
      return `лишние поля ${issue.keys.join(', ')}`;
    default:
      return null;
  }
};

/**
 * Тексты стандартных проверок запроса по-русски и с полем, к которому они относятся. Сообщения,
 * заданные в самой схеме, zod берёт как есть: до этой карты они не доходят.
 */
export const replayErrorMap: ZodErrorMap = (issue, ctx) => ({
  message: `${issue.path.length === 0 ? 'запрос' : issue.path.join('.')}: ${standardText(issue) ?? ctx.defaultError}`,
});

/**
 * Окно запроса с точностью до миллисекунды и в UTC: база хранит микросекунды и округляет,
 * а проверки окна считают по Date.parse, который лишние цифры отбрасывает.
 */
export const millisecondWindowOf = <T extends Pick<ReplayRequest, 'from' | 'to'>>(
  request: T,
): T => ({
  ...request,
  from: toIsoTimestamp(Date.parse(request.from)),
  to: toIsoTimestamp(Date.parse(request.to)),
});

/**
 * Окно запроса в пределах срока хранения сырых кадров и не в будущем. Допуск в обе стороны:
 * окно, выбранное в форме ровно по границе, отправляется на несколько секунд позже.
 */
export const windowIssues = (
  request: Pick<ReplayRequest, 'from' | 'to'>,
  nowMs: number,
): string[] => {
  const issues: string[] = [];
  const oldestMs = nowMs - REPLAY_RETENTION_MS;

  if (Date.parse(request.from) < oldestMs - REPLAY_FUTURE_SLACK_MS) {
    issues.push(
      `начало окна раньше ${toIsoTimestamp(oldestMs)}: более старые сырые кадры брокер уже удалил`,
    );
  }
  if (Date.parse(request.to) > nowMs + REPLAY_FUTURE_SLACK_MS) {
    issues.push('конец окна в будущем: перепрогнать можно только уже собранные кадры');
  }

  return issues;
};

/** Приборы запроса, которых нет в топологии стенда. */
export const unknownDevicesOf = (
  deviceCodes: readonly string[],
  known: ReadonlyMap<string, unknown>,
): string[] => deviceCodes.filter((code) => !known.has(code));

/** Уставка после одной правки: заданное поле заменяется, null снимает границу, пропуск оставляет. */
const patchRule = (rule: AlarmRule, patch: ReplayPatch): AlarmRule => {
  const next: AlarmRule = { ...rule };

  for (const field of REPLAY_PATCH_FIELDS) {
    const value = patch[field];
    if (value !== undefined) Object.assign(next, { [field]: value });
  }

  return next;
};

const sameRule = (a: AlarmRule, b: AlarmRule): boolean =>
  a.minValue === b.minValue &&
  a.maxValue === b.maxValue &&
  a.hysteresis === b.hysteresis &&
  a.debounceCycles === b.debounceCycles &&
  a.severity === b.severity &&
  a.enabled === b.enabled;

/** Причина отказа правки, которая не меняет ни одной действующей уставки. */
const unchangedIssue = (name: string, changedDisabled: boolean, anyEnabled: boolean): string => {
  if (!changedDisabled) return `${name}: значения совпадают с текущими, сравнивать нечего`;

  return anyEnabled
    ? `${name}: у включённых уставок значения совпадают с текущими, а у выключенных правка на срабатывания не влияет`
    : `${name}: уставка выключена у всех выбранных приборов и на срабатывания не влияет, включите её в правке (enabled: true)`;
};

/**
 * Применяет правки к снимку уставок выбранных приборов. Правка ложится на все приборы, у которых
 * есть уставка с её метрикой и режимом. Отказ, если правка не нашла ни одной уставки, ничего
 * не меняет или делает уставку неверной: причины называют прибор, метрику и режим. Уставка,
 * выключенная и до правки, и после, на срабатывания не влияет и изменением не считается.
 */
export const applyPatches = (
  baseline: readonly AlarmRule[],
  patches: readonly ReplayPatch[],
): PatchOutcome => {
  const issues: string[] = [];
  const rules = baseline.map((rule) => ({ ...rule }));

  for (const patch of patches) {
    const name = `правка ${patch.metricKey}/${patch.mode}`;
    const targets = rules
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => rule.metricKey === patch.metricKey && rule.mode === patch.mode);

    if (targets.length === 0) {
      issues.push(`${name}: у выбранных приборов нет такой уставки`);
      continue;
    }

    const issuesBefore = issues.length;
    let changed = false;
    let changedDisabled = false;
    let anyEnabled = false;
    for (const { rule, index } of targets) {
      const parsed = alarmRuleSchema.safeParse(patchRule(rule, patch));
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          issues.push(
            issue.code === 'custom'
              ? `${name}: ${issue.message}`
              : `${name}: уставка ${keyOf(rule)}, поле ${issue.path.join('.')}: ${issue.message}`,
          );
        }
        continue;
      }

      if (rule.enabled) anyEnabled = true;
      if (!sameRule(rule, parsed.data)) {
        if (rule.enabled || parsed.data.enabled) changed = true;
        else changedDisabled = true;
      }
      rules[index] = parsed.data;
    }

    if (!changed && issues.length === issuesBefore) {
      issues.push(unchangedIssue(name, changedDisabled, anyEnabled));
    }
  }

  return issues.length === 0 ? { ok: true, rules } : { ok: false, issues };
};

/** Снимок уставок обоих вариантов, разобранный общей схемой. */
export interface ParsedRulesSnapshot {
  readonly baseline: ReplayRulesSnapshot;
  readonly patched: ReplayRulesSnapshot;
}

/** Итог разбора снимка: снимок или причины, по которым запись испорчена. */
export type RulesSnapshotOutcome =
  | { readonly ok: true; readonly snapshot: ParsedRulesSnapshot }
  | { readonly ok: false; readonly issues: string[] };

/** Причины отказа разбора одного варианта: вариант, путь поля и текст проверки. */
const snapshotIssuesOf = (variant: ReplayVariant, error: ZodError | undefined): string[] =>
  (error?.issues ?? []).map((issue) => `${[variant, ...issue.path].join('.')}: ${issue.message}`);

/** Разбор снимка общей схемой: у испорченной записи причины называют вариант и поле. */
export const parseRulesSnapshot = (rules: ReplayRunRules): RulesSnapshotOutcome => {
  const baseline = replayRulesSnapshotSchema.safeParse(rules.baseline);
  const patched = replayRulesSnapshotSchema.safeParse(rules.patched);

  return baseline.success && patched.success
    ? { ok: true, snapshot: { baseline: baseline.data, patched: patched.data } }
    : {
        ok: false,
        issues: [
          ...snapshotIssuesOf('baseline', baseline.error),
          ...snapshotIssuesOf('patched', patched.error),
        ],
      };
};

const valuesOf = (rule: AlarmRule): ReplayRuleValues => ({
  minValue: rule.minValue,
  maxValue: rule.maxValue,
  hysteresis: rule.hysteresis,
  debounceCycles: rule.debounceCycles,
  severity: rule.severity,
  enabled: rule.enabled,
});

/**
 * Уставки приборов, которые правка действительно изменила, по прибору, метрике и режиму.
 * Уставка, выключенная и до правки, и после, на срабатывания не влияет, как и в applyPatches.
 */
export const changedRulesOf = (snapshot: ParsedRulesSnapshot): ReplayChangedRule[] => {
  const patchedByKey = new Map(snapshot.patched.map((rule) => [keyOf(rule), rule]));
  const changed: ReplayChangedRule[] = [];

  for (const rule of snapshot.baseline) {
    const patched = patchedByKey.get(keyOf(rule));
    if (patched === undefined || sameRule(rule, patched)) continue;
    if (!rule.enabled && !patched.enabled) continue;

    changed.push({
      deviceCode: rule.deviceCode,
      metricKey: rule.metricKey,
      mode: rule.mode,
      baseline: valuesOf(rule),
      patched: valuesOf(patched),
    });
  }

  return changed.sort(compareKeys);
};

/**
 * Окно живых эпизодов: фактическое покрытие прогона, а не запрошенное окно. Покрытие это время
 * первого и последнего кадра включительно, а подсчёт в базе полуоткрытый, поэтому конец сдвинут
 * на миллисекунду. Без покрытия считать нечего.
 */
export const liveWindowOf = (
  run: Pick<ReplayRun, 'coveredFrom' | 'coveredTo' | 'deviceCodes'>,
): LiveAlarmEpisodeWindow | null =>
  run.coveredFrom === null || run.coveredTo === null
    ? null
    : {
        from: run.coveredFrom,
        to: toIsoTimestamp(Date.parse(run.coveredTo) + 1),
        deviceCodes: run.deviceCodes,
      };

/**
 * Строки разницы: сводка эпизодов обоих вариантов и живые эпизоды за покрытие. Ключ только
 * с живыми эпизодами тоже строка: перепрогон «было» их не повторил, и это видно. Сверху строки
 * с наибольшим числом эпизодов без пары, затем с наибольшей разницей счёта.
 */
export const diffRowsOf = (
  summary: readonly ReplayEpisodeSummaryRow[],
  live: readonly LiveAlarmEpisodeCount[],
): ReplayDiffRow[] => {
  const rows = new Map<string, ReplayDiffRow>();

  for (const row of summary) {
    rows.set(keyOf(row), { ...row, live: 0 });
  }
  for (const count of live) {
    const key = keyOf(count);
    const row = rows.get(key) ?? {
      deviceCode: count.deviceCode,
      metricKey: count.metricKey,
      mode: count.mode,
      baseline: 0,
      patched: 0,
      added: 0,
      removed: 0,
      live: 0,
    };
    rows.set(key, { ...row, live: row.live + count.episodes });
  }

  return [...rows.values()].sort(
    (a, b) =>
      b.added + b.removed - (a.added + a.removed) ||
      Math.abs(b.patched - b.baseline) - Math.abs(a.patched - a.baseline) ||
      compareKeys(a, b),
  );
};

/** Почему стенд занят: какой перепрогон ждёт или идёт и кто его запустил. */
export const busyMessage = (active: Pick<ReplayRun, 'requestedBy' | 'status'> | null): string =>
  active === null
    ? 'на стенде уже идёт другой перепрогон, повторите запуск позже'
    : `перепрогон на стенде уже ${active.status === 'queued' ? 'ждёт процессора' : 'идёт'}, его запустил ${active.requestedBy}: дождитесь итога и повторите запуск`;

/** Почему итога прогона пока нет: ждёт, идёт или завершён с ошибкой. */
export const unfinishedMessage = (run: Pick<ReplayRun, 'status' | 'error'>): string => {
  if (run.status === 'failed') {
    return `прогон завершён с ошибкой, итога нет: ${run.error ?? 'причина не записана'}`;
  }
  if (run.status === 'queued') return 'прогон ждёт процессора: итог появится после завершения';
  return 'прогон ещё идёт: итог появится после завершения';
};
