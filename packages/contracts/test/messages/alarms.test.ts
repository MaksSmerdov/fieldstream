import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { alarmEventSchema, alarmRuleSchema } from '../../src/messages/alarms.js';

/** Ошибки схемы как "код путь: текст" или падение теста, если кривое значение прошло разбор. */
const issuesOf = (schema: z.ZodTypeAny, value: unknown): string => {
  const result = schema.safeParse(value);
  if (result.success) throw new Error('ожидалась ошибка схемы, а значение прошло разбор');
  return result.error.issues
    .map((issue) => `${issue.code} ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
};

const rule = (extra: Record<string, unknown> = {}): unknown => ({
  deviceCode: 'RC-101',
  metricKey: 'supply_temp_c',
  mode: 'cooling',
  minValue: null,
  maxValue: -15,
  ...extra,
});

const event = (extra: Record<string, unknown> = {}): unknown => ({
  schema: 'alarm.event',
  v: 1,
  alarmId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  dedupeKey: 'RC-101|supply_temp_c|cooling|raised',
  deviceCode: 'RC-101',
  metricKey: 'supply_temp_c',
  mode: 'cooling',
  state: 'raised',
  severity: 'critical',
  value: -8.2,
  threshold: -15,
  boundary: 'max',
  occurredAt: '2026-09-11T10:00:00.000Z',
  traceId: '0123456789abcdef',
  ...extra,
});

describe('alarmRuleSchema', () => {
  it('уставка получает дефолты возврата, дебаунса и важности', () => {
    expect(alarmRuleSchema.parse(rule())).toEqual({
      deviceCode: 'RC-101',
      metricKey: 'supply_temp_c',
      mode: 'cooling',
      minValue: null,
      maxValue: -15,
      hysteresis: 0,
      debounceCycles: 1,
      severity: 'warning',
      enabled: true,
    });
  });

  it('одной границы достаточно', () => {
    expect(alarmRuleSchema.parse(rule({ minValue: -30, maxValue: null })).minValue).toBe(-30);
    expect(alarmRuleSchema.parse(rule({ minValue: null, maxValue: -15 })).maxValue).toBe(-15);
  });

  it('перевёрнутые границы отвергаются и ошибка называет уставку', () => {
    expect(issuesOf(alarmRuleSchema, rule({ minValue: -10, maxValue: -20 }))).toContain(
      'уставка RC-101/supply_temp_c/cooling: minValue должен быть меньше maxValue',
    );
    expect(issuesOf(alarmRuleSchema, rule({ minValue: -15, maxValue: -15 }))).toContain(
      'minValue должен быть меньше maxValue',
    );
  });

  it('уставка без единой границы отвергается', () => {
    expect(issuesOf(alarmRuleSchema, rule({ minValue: null, maxValue: null }))).toContain(
      'нужна хотя бы одна граница',
    );
  });

  it('отрицательный возврат и нулевой дебаунс отвергаются', () => {
    expect(issuesOf(alarmRuleSchema, rule({ hysteresis: -1 }))).toContain('too_small hysteresis');
    expect(issuesOf(alarmRuleSchema, rule({ debounceCycles: 0 }))).toContain(
      'too_small debounceCycles',
    );
  });
});

describe('alarmEventSchema', () => {
  it('событие с ключом дедупликации проходит разбор', () => {
    const parsed = alarmEventSchema.parse(event());

    expect(parsed.dedupeKey).toBe('RC-101|supply_temp_c|cooling|raised');
    expect(parsed.state).toBe('raised');
  });

  it('снятие аларма без значения допустимо', () => {
    expect(alarmEventSchema.parse(event({ state: 'cleared', value: null })).value).toBeNull();
  });

  it('идентификатор не uuid и пустой ключ дедупликации отвергаются', () => {
    expect(issuesOf(alarmEventSchema, event({ alarmId: 'alarm-1' }))).toContain('alarmId');
    expect(issuesOf(alarmEventSchema, event({ dedupeKey: '' }))).toContain('too_small dedupeKey');
  });

  it('лишний ключ в событии отвергается', () => {
    expect(issuesOf(alarmEventSchema, event({ note: 'вручную' }))).toContain('unrecognized_keys');
  });
});
