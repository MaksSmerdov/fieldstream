import { describe, expect, it } from 'vitest';
import { simFaultRequestSchema, simSpeedRequestSchema } from '../../src/topology/sim.js';

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

describe('simSpeedRequestSchema', () => {
  it('ускорение ограничено диапазоном 1..60', () => {
    expect(simSpeedRequestSchema.safeParse({ factor: 60 }).success).toBe(true);
    expect(simSpeedRequestSchema.safeParse({ factor: 0.5 }).success).toBe(false);
    expect(simSpeedRequestSchema.safeParse({ factor: 61 }).success).toBe(false);
  });
});
