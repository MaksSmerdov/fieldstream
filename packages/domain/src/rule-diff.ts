import type { AlarmRuleAuditField } from '@fieldstream/contracts';

/** Поля уставки, которые видно в журнале правок, в порядке показа. */
const FIELDS = [
  'minValue',
  'maxValue',
  'hysteresis',
  'debounceCycles',
  'severity',
  'enabled',
] as const;

type Comparable = Record<string, unknown>;

/**
 * Что изменилось в уставке. Сравниваются значения полей, а не строки JSON: порядок ключей
 * и лишние поля не должны превращаться в правку, которой не было. Создание уставки правкой
 * полей не считается: у неё нет прежнего состояния, с которым можно сравнить.
 */
export const ruleDiff = (
  before: Comparable | null | undefined,
  after: Comparable,
): AlarmRuleAuditField[] => {
  if (before === null || before === undefined) return [];

  return FIELDS.flatMap((field) => {
    const left = before[field];
    const right = after[field];
    if (left === right) return [];

    return [{ field, before: value(left), after: value(right) }];
  });
};

/** Значение для журнала: всё, что не число, строка или признак, показывать нечем. */
const value = (raw: unknown): AlarmRuleAuditField['before'] => {
  if (typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean') return raw;

  return null;
};
