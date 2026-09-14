import { describe, expect, it } from 'vitest';
import {
  simClearFaultsQuerySchema,
  simClearFaultsResultSchema,
  simFaultRequestSchema,
  simSpeedRequestSchema,
} from '../../src/topology/sim.js';

/** Сообщения ошибок разбора: по ним видно, какое правило сработало. */
const messagesOf = (input: unknown): string[] => {
  const parsed = simFaultRequestSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe('simFaultRequestSchema', () => {
  it('подставляет срок жизни и код исключения по умолчанию', () => {
    const parsed = simFaultRequestSchema.parse({
      targetKind: 'device',
      targetId: 'RC-101',
      kind: 'exception',
    });

    expect(parsed.ttlSec).toBe(300);
    expect(parsed.exceptionCode).toBe(4);
  });

  it('обрыв порта и провал напряжения вносятся только на линию', () => {
    expect(messagesOf({ targetKind: 'device', targetId: 'RC-101', kind: 'offline' })).toEqual([
      'поломка "offline" вносится только на линию',
    ]);
    expect(messagesOf({ targetKind: 'line', targetId: 'L2', kind: 'power_dip' })).toEqual([]);
  });

  it('залипшая дверь, оттайка и уход за шкалу вносятся только на прибор', () => {
    for (const kind of ['door_stuck', 'defrost', 'offscale']) {
      expect(messagesOf({ targetKind: 'line', targetId: 'L1', kind })).toEqual([
        `поломка "${kind}" вносится только на прибор`,
      ]);
    }
  });

  it('код цели проверяется по виду цели', () => {
    expect(messagesOf({ targetKind: 'line', targetId: 'RC-101', kind: 'silent' })).toEqual([
      'ожидается код линии вида L1',
    ]);
    expect(messagesOf({ targetKind: 'device', targetId: 'L1', kind: 'silent' })).toEqual([
      'ожидается код прибора вида RC-101',
    ]);
  });

  it('paramKey допустим только для ухода за шкалу', () => {
    expect(
      messagesOf({ targetKind: 'device', targetId: 'RC-101', kind: 'crc', paramKey: 'x' }),
    ).toEqual(['paramKey задаётся только для поломки "offscale"']);
  });

  it('лишние поля отвергаются', () => {
    expect(
      simFaultRequestSchema.safeParse({
        targetKind: 'device',
        targetId: 'RC-101',
        kind: 'silent',
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe('simClearFaultsQuerySchema', () => {
  const accepts = (input: unknown): boolean => simClearFaultsQuerySchema.safeParse(input).success;

  it('без фильтров запрос допустим: снимаются все поломки', () => {
    expect(simClearFaultsQuerySchema.parse({})).toEqual({});
  });

  it('цель задаётся кодом линии или прибора', () => {
    expect(accepts({ targetId: 'L1' })).toBe(true);
    expect(accepts({ targetId: 'RC-101' })).toBe(true);
    expect(accepts({ targetId: 'RC-1' })).toBe(false);
    expect(accepts({ targetId: '' })).toBe(false);
  });

  it('вид поломки берётся из списка и сочетается с целью', () => {
    expect(accepts({ kind: 'silent' })).toBe(true);
    expect(accepts({ targetId: 'RC-101', kind: 'stall' })).toBe(true);
    expect(accepts({ kind: 'meteor' })).toBe(false);
  });

  it('лишние параметры отвергаются', () => {
    expect(accepts({ lineCode: 'L1' })).toBe(false);
  });
});

describe('simClearFaultsResultSchema', () => {
  it('число снятых поломок целое и неотрицательное', () => {
    const accepts = (input: unknown): boolean =>
      simClearFaultsResultSchema.safeParse(input).success;

    expect(accepts({ removed: 0 })).toBe(true);
    expect(accepts({ removed: 3 })).toBe(true);
    expect(accepts({ removed: -1 })).toBe(false);
    expect(accepts({ removed: 1.5 })).toBe(false);
    expect(accepts({ removed: 1, extra: true })).toBe(false);
  });
});

describe('simSpeedRequestSchema', () => {
  it('ускорение ограничено диапазоном 1..60', () => {
    expect(simSpeedRequestSchema.safeParse({ factor: 60 }).success).toBe(true);
    expect(simSpeedRequestSchema.safeParse({ factor: 0.5 }).success).toBe(false);
    expect(simSpeedRequestSchema.safeParse({ factor: 61 }).success).toBe(false);
  });
});
