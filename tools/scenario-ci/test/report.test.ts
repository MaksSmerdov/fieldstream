import { describe, expect, it } from 'vitest';
import type { ScenarioRunStep } from '@fieldstream/contracts';
import {
  changedSteps,
  durationMsOf,
  formatDuration,
  formatSummary,
  outcomeLine,
  stepLine,
} from '../src/report.js';

const step = (patch: Partial<ScenarioRunStep>): ScenarioRunStep => ({
  index: 1,
  kind: 'waitFor',
  title: 'Дождаться, пока размыкатель RC-105 разомкнётся, не дольше 45 с',
  status: 'pending',
  startedAt: null,
  finishedAt: null,
  detail: null,
  ...patch,
});

describe('таблица итогов', () => {
  it('строка на сценарий, итог, длительность и причина провала с экранированной чертой', () => {
    const summary = formatSummary([
      {
        name: 'dead-device',
        title: 'Мёртвый прибор',
        passed: true,
        durationMs: 192_400,
        error: null,
      },
      {
        name: 'crc-garbage',
        title: 'Мусор в кадре',
        passed: false,
        durationMs: null,
        error: 'шаг 2 «a | b»:\nне дождались',
      },
    ]);

    expect(summary).toBe(
      [
        '### Сценарии стенда',
        '',
        '| Сценарий | Итог | Длительность | Подробности |',
        '| --- | --- | --- | --- |',
        '| `dead-device` Мёртвый прибор | прошёл | 3 мин 12 с |  |',
        '| `crc-garbage` Мусор в кадре | не прошёл | - | шаг 2 «a \\| b»: не дождались |',
        '',
        'Прошли 1 из 2.',
      ].join('\n'),
    );
  });

  it('оборванный прогон называет причину, пустая таблица не рисуется', () => {
    expect(formatSummary([], 'вход engineer@fieldstream.local не удался')).toBe(
      [
        '### Сценарии стенда',
        '',
        'Прогон сценариев оборвался: вход engineer@fieldstream.local не удался',
        '',
        'Прошли 0 из 0.',
      ].join('\n'),
    );
  });

  it('длительность в секундах и минутах, неизвестная прочерком', () => {
    expect(formatDuration(42_400)).toBe('42 с');
    expect(formatDuration(60_000)).toBe('1 мин 0 с');
    expect(formatDuration(null)).toBe('-');
    expect(
      durationMsOf({
        startedAt: '2026-09-15T10:00:00.000Z',
        finishedAt: '2026-09-15T10:01:30.000Z',
      }),
    ).toBe(90_000);
    expect(durationMsOf({ startedAt: '2026-09-15T10:00:00.000Z', finishedAt: null })).toBeNull();
  });

  it('итоговая строка сценария называет причину провала', () => {
    expect(
      outcomeLine({ name: 'x', title: 'X', passed: false, durationMs: 5_000, error: 'сбой' }),
    ).toBe('x: не прошёл за 5 с: сбой');
    expect(
      outcomeLine({ name: 'x', title: 'X', passed: true, durationMs: null, error: null }),
    ).toBe('x: прошёл');
  });
});

describe('ход шагов в журнале', () => {
  it('в журнал идут только сменившие статус шаги, ожидающие пропускаются', () => {
    const seen = new Map([[0, 'passed' as const]]);
    const steps = [
      step({ index: 0, status: 'passed' }),
      step({ index: 1, status: 'running' }),
      step({ index: 2, status: 'pending' }),
    ];

    expect(changedSteps(seen, steps).map((item) => item.index)).toEqual([1]);
  });

  it('у завершённого шага видно, что увидели, у идущего только заголовок', () => {
    expect(stepLine('dead-device', step({ status: 'running', detail: 'промежуточное' }), 8)).toBe(
      'dead-device, шаг 2 из 8, идёт: Дождаться, пока размыкатель RC-105 разомкнётся, не дольше 45 с',
    );
    expect(
      stepLine(
        'dead-device',
        step({ status: 'passed', detail: 'RC-105: размыкатель разомкнут' }),
        8,
      ),
    ).toBe(
      'dead-device, шаг 2 из 8, пройден: Дождаться, пока размыкатель RC-105 разомкнётся, не дольше 45 с (RC-105: размыкатель разомкнут)',
    );
  });
});
