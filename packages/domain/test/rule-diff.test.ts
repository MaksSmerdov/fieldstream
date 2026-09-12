import { describe, expect, it } from 'vitest';
import { ruleDiff } from '../src/rule-diff.js';

const rule = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  metricKey: 'supply_temp_c',
  mode: 'cooling',
  minValue: -28,
  maxValue: 2,
  hysteresis: 1,
  debounceCycles: 3,
  severity: 'warning',
  enabled: true,
  ...patch,
});

describe('разница уставок', () => {
  it('видит изменённые поля и несёт прежнее и новое значение', () => {
    expect(ruleDiff(rule(), rule({ maxValue: 4, severity: 'critical' }))).toEqual([
      { field: 'maxValue', before: 2, after: 4 },
      { field: 'severity', before: 'warning', after: 'critical' },
    ]);
  });

  /** Лишние поля и порядок ключей не должны превращаться в правку, которой не было. */
  it('те же значения правкой не считаются, даже если рядом лежит что-то ещё', () => {
    expect(ruleDiff(rule({ updatedBy: 'кто-то' }), rule())).toEqual([]);
  });

  it('снятая граница показывается пустым значением, а не пропадает', () => {
    expect(ruleDiff(rule(), rule({ minValue: null }))).toEqual([
      { field: 'minValue', before: -28, after: null },
    ]);
  });

  it('заведение уставки правкой полей не считается: сравнивать не с чем', () => {
    expect(ruleDiff(null, rule())).toEqual([]);
  });

  it('поля идут в постоянном порядке, а не в порядке ключей объекта', () => {
    const changed = ruleDiff(rule(), rule({ enabled: false, minValue: -30 }));

    expect(changed.map((field) => field.field)).toEqual(['minValue', 'enabled']);
  });
});
