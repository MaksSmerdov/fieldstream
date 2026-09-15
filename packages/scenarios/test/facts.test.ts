import { describe, expect, it } from 'vitest';
import { countReconnectsSince, evaluateProbe } from '../src/facts.js';
import type { ProbeContext, StandFacts } from '../src/facts.js';
import { probeSchema } from '../src/schema.js';

const baseFacts: StandFacts = {
  breakers: { 'RC-105': 'open', 'RC-104': 'closed', 'RC-101': 'half_open' },
  devices: {
    'RC-102': { status: 'online', reason: 'ok', mode: 'cooling' },
    'RC-104': { status: 'online', reason: 'ok', mode: 'cooling' },
    'RC-105': { status: 'offline', reason: 'consecutive_errors', mode: 'cooling' },
    'PM-204': { status: 'online', reason: 'ok', mode: null },
  },
  lines: {
    L2: {
      connected: true,
      reconnects: 0,
      lastCycle: { at: '2026-09-15T10:00:00.000Z', outcome: 'polled', durationMs: 1840 },
    },
    L3: { connected: false, reconnects: 4, lastCycle: null },
  },
  activeAlarms: [{ deviceCode: 'RC-102', metricKey: 'supply_temp_c' }],
  alarmsRaisedSinceStart: { supply_temp_c: 0, door_open: 2 },
  dlqTotal: 12,
};

const context: ProbeContext = { baselines: { 'l2-cycle': 1700 }, dlqAtStart: 12 };

const evaluate = (probe: unknown, facts: StandFacts = baseFacts) =>
  evaluateProbe(probeSchema.parse(probe), facts, context);

describe('evaluateProbe: размыкатель', () => {
  it('совпадение состояния', () => {
    expect(evaluate({ breaker: { deviceCode: 'RC-105', state: 'open' } })).toEqual({
      ok: true,
      observed: 'RC-105: размыкатель разомкнут',
    });
  });

  it('другое состояние это не ok с тем, что увидели', () => {
    expect(evaluate({ breaker: { deviceCode: 'RC-105', state: 'closed' } })).toEqual({
      ok: false,
      observed: 'RC-105: размыкатель разомкнут',
    });
    expect(evaluate({ breaker: { deviceCode: 'RC-101', state: 'closed' } })).toEqual({
      ok: false,
      observed: 'RC-101: размыкатель полуразомкнут, идёт проба',
    });
  });

  it('прибора нет в фактах', () => {
    expect(evaluate({ breaker: { deviceCode: 'RC-999', state: 'open' } })).toEqual({
      ok: false,
      observed: 'RC-999: размыкателя нет в снимке стенда',
    });
  });
});

describe('evaluateProbe: прибор', () => {
  it('статус и причина совпадают', () => {
    expect(
      evaluate({
        device: { deviceCode: 'RC-105', status: 'offline', reason: 'consecutive_errors' },
      }),
    ).toEqual({
      ok: true,
      observed: 'RC-105: не на связи (отказы подряд), режим «охлаждение»',
    });
  });

  it('несовпадение любого заданного поля это не ok', () => {
    expect(evaluate({ device: { deviceCode: 'RC-105', status: 'online' } }).ok).toBe(false);
    expect(
      evaluate({ device: { deviceCode: 'RC-105', status: 'offline', reason: 'stale' } }).ok,
    ).toBe(false);
    expect(evaluate({ device: { deviceCode: 'RC-104', mode: 'defrost' } }).ok).toBe(false);
  });

  it('у счётчика режима нет', () => {
    expect(evaluate({ device: { deviceCode: 'PM-204', mode: 'defrost' } })).toEqual({
      ok: false,
      observed: 'PM-204: на связи, режима не сообщает',
    });
    expect(evaluate({ device: { deviceCode: 'PM-204', status: 'online' } })).toEqual({
      ok: true,
      observed: 'PM-204: на связи',
    });
  });

  it('прибора нет в фактах', () => {
    expect(evaluate({ device: { deviceCode: 'RC-999', status: 'online' } })).toEqual({
      ok: false,
      observed: 'RC-999: прибора нет в снимке стенда',
    });
  });
});

describe('evaluateProbe: линия', () => {
  it('обход в пределах процента от базового', () => {
    expect(
      evaluate({ line: { lineCode: 'L2', durationWithinPct: { of: 'l2-cycle', pct: 15 } } }),
    ).toEqual({ ok: true, observed: 'L2: обход 1840 мс, базовый 1700 мс, +8%' });
  });

  it('обход длиннее допуска это не ok', () => {
    expect(
      evaluate({ line: { lineCode: 'L2', durationWithinPct: { of: 'l2-cycle', pct: 5 } } }),
    ).toEqual({ ok: false, observed: 'L2: обход 1840 мс, базовый 1700 мс, +8%' });
  });

  it('обход короче базового не нарушение', () => {
    const faster: StandFacts = {
      ...baseFacts,
      lines: {
        L2: {
          connected: true,
          reconnects: 0,
          lastCycle: { at: 'x', outcome: 'polled', durationMs: 1500 },
        },
      },
    };

    expect(
      evaluate({ line: { lineCode: 'L2', durationWithinPct: { of: 'l2-cycle', pct: 5 } } }, faster),
    ).toEqual({ ok: true, observed: 'L2: обход 1500 мс, базовый 1700 мс, -12%' });
  });

  it('не опросный обход длительность не подтверждает', () => {
    const idle: StandFacts = {
      ...baseFacts,
      lines: {
        L2: {
          connected: true,
          reconnects: 0,
          lastCycle: { at: 'x', outcome: 'idle', durationMs: 0 },
        },
      },
    };

    expect(
      evaluate({ line: { lineCode: 'L2', durationWithinPct: { of: 'l2-cycle', pct: 15 } } }, idle),
    ).toEqual({
      ok: false,
      observed:
        'L2: последний обход не опросный (простой, опрашивать некого), длительность не показательна',
    });
  });

  it('подключение и попытки переподключения', () => {
    expect(evaluate({ line: { lineCode: 'L3', connected: false, reconnectsAtLeast: 3 } })).toEqual({
      ok: true,
      observed: 'L3: порт не подключён, попыток переподключения с начала прогона 4',
    });
    expect(evaluate({ line: { lineCode: 'L3', connected: false, reconnectsAtLeast: 5 } })).toEqual({
      ok: false,
      observed: 'L3: порт не подключён, попыток переподключения с начала прогона 4',
    });
    expect(evaluate({ line: { lineCode: 'L2', connected: false } })).toEqual({
      ok: false,
      observed: 'L2: порт подключён',
    });
  });

  it('базовая не снята или обходов не было', () => {
    expect(
      evaluate({ line: { lineCode: 'L2', durationWithinPct: { of: 'other', pct: 15 } } }),
    ).toEqual({ ok: false, observed: 'L2: базовая длительность «other» не снята' });
    expect(
      evaluate({ line: { lineCode: 'L3', durationWithinPct: { of: 'l2-cycle', pct: 15 } } }),
    ).toEqual({ ok: false, observed: 'L3: обходов ещё не было' });
  });

  it('линии нет в фактах', () => {
    expect(evaluate({ line: { lineCode: 'L9', connected: true } })).toEqual({
      ok: false,
      observed: 'L9: линии нет в снимке стенда',
    });
  });
});

describe('countReconnectsSince', () => {
  it('считает только попытки не раньше начала прогона, в том числе со смещением', () => {
    const attempts = [
      { at: '2026-09-15T09:59:58.000Z' },
      { at: '2026-09-15T10:00:00.000Z' },
      { at: '2026-09-15T10:00:01.000Z' },
      { at: '2026-09-15T13:00:03.000+03:00' },
    ];

    expect(countReconnectsSince(attempts, '2026-09-15T10:00:00.000Z')).toBe(3);
    expect(countReconnectsSince(attempts, '2026-09-15T10:00:05.000Z')).toBe(0);
  });
});

describe('evaluateProbe: алармы', () => {
  it('активный аларм по метрике', () => {
    expect(
      evaluate({ alarm: { deviceCode: 'RC-102', metricKey: 'supply_temp_c', active: true } }),
    ).toEqual({ ok: true, observed: 'RC-102: активен аларм supply_temp_c' });
    expect(
      evaluate({ alarm: { deviceCode: 'RC-102', metricKey: 'supply_temp_c', active: false } }),
    ).toEqual({ ok: false, observed: 'RC-102: активен аларм supply_temp_c' });
  });

  it('нет активного аларма', () => {
    expect(
      evaluate({ alarm: { deviceCode: 'RC-104', metricKey: 'supply_temp_c', active: false } }),
    ).toEqual({ ok: true, observed: 'RC-104: активных алармов по supply_temp_c нет' });
    expect(evaluate({ alarm: { deviceCode: 'RC-104', active: true } })).toEqual({
      ok: false,
      observed: 'RC-104: активных алармов нет',
    });
  });

  it('прибора нет в фактах', () => {
    expect(evaluate({ alarm: { deviceCode: 'RC-999', active: false } })).toEqual({
      ok: false,
      observed: 'RC-999: прибора нет в снимке стенда',
    });
  });

  it('поднятые с начала прогона', () => {
    expect(evaluate({ noAlarmsRaised: { metricKey: 'supply_temp_c' } })).toEqual({
      ok: true,
      observed: 'с начала прогона поднято алармов по supply_temp_c: 0',
    });
    expect(evaluate({ noAlarmsRaised: {} })).toEqual({
      ok: false,
      observed: 'с начала прогона поднято алармов: 2',
    });
    expect(evaluate({ noAlarmsRaised: null })).toEqual({
      ok: false,
      observed: 'с начала прогона поднято алармов: 2',
    });
  });
});

describe('evaluateProbe: очередь недоставленных', () => {
  it('не выросла', () => {
    expect(evaluate({ dlqUnchanged: true })).toEqual({
      ok: true,
      observed: 'в очереди недоставленных 12, на старте было 12',
    });
  });

  it('выросла', () => {
    expect(evaluate({ dlqUnchanged: true }, { ...baseFacts, dlqTotal: 15 })).toEqual({
      ok: false,
      observed: 'в очереди недоставленных 15, на старте было 12, +3',
    });
  });
});
