import { describe, expect, it } from 'vitest';
import type { LiveSample } from '../src/measure.js';
import {
  coarseWindow,
  committedOffset,
  delayStats,
  delaysOf,
  devicesOf,
  expectedRate,
  hasCommits,
  isStaleGatewayGroup,
  lagText,
  linePlansOf,
  partitionLags,
  planTotals,
  pollText,
  rateOf,
  totalLag,
  uncommittedText,
} from '../src/pipeline.js';

/** Выборка по линиям в том виде, в каком её печатает psql: все ячейки текстом. */
const planRows = [
  { line_code: 'L1', poll_interval_ms: '10000', devices: '6', metrics_per_poll: '54' },
  { line_code: 'L2', poll_interval_ms: '5000', devices: '6', metrics_per_poll: '54' },
];

/** Кадр показаний живого канала с заданной меткой времени. */
const reading = (deviceCode: string, ts: string, atMs: number): LiveSample => ({
  frame: {
    kind: 'reading',
    id: `${deviceCode}-${ts}`,
    data: { deviceCode, ts, mode: 'cooling', quality: 'ok', metrics: { supply_temp_c: -18.2 } },
  },
  atMs,
});

describe('топология стенда для расчётного темпа', () => {
  it('строка выборки становится планом линии', () => {
    expect(linePlansOf(planRows)).toEqual([
      { lineCode: 'L1', pollIntervalMs: 10_000, devices: 6, metricsPerPoll: 54 },
      { lineCode: 'L2', pollIntervalMs: 5_000, devices: 6, metricsPerPoll: 54 },
    ]);
  });

  it('строка без такта, с нулевым тактом или без метрик в расчёт не идёт', () => {
    expect(
      linePlansOf([
        { line_code: 'L3', poll_interval_ms: null, devices: '6', metrics_per_poll: '54' },
        { line_code: 'L4', poll_interval_ms: '0', devices: '6', metrics_per_poll: '54' },
        { line_code: 'L5', poll_interval_ms: '10000', devices: '6', metrics_per_poll: null },
        { line_code: null, poll_interval_ms: '10000', devices: '6', metrics_per_poll: '54' },
      ]),
    ).toEqual([]);
  });

  it('расчётный темп это строки за обход, делённые на такт линии', () => {
    expect(expectedRate(linePlansOf(planRows))).toBeCloseTo(5.4 + 10.8, 6);
    expect(expectedRate([])).toBeNull();
  });

  it('итоги плана считают приборы и строки за обход', () => {
    expect(planTotals(linePlansOf(planRows))).toEqual({ devices: 12, metricsPerPoll: 108 });
  });

  it('такты линий печатаются строкой, а пустая топология говорит об этом словами', () => {
    expect(pollText(linePlansOf(planRows))).toBe(
      'L1 10000 мс (приборов: 6), L2 5000 мс (приборов: 6)',
    );
    expect(pollText([])).toBe('включённых линий в топологии нет');
  });
});

describe('темп записи за окно', () => {
  it('строки окна делятся на его длину', () => {
    expect(rateOf(1_296, 60_000)).toBeCloseTo(21.6, 6);
  });

  it('пустое окно это отсутствие темпа, а не ноль', () => {
    expect(rateOf(0, 60_000)).toBeNull();
    expect(rateOf(10, 0)).toBeNull();
  });

  it('окно короче трёх обходов самой медленной линии считается грубым', () => {
    const plans = linePlansOf(planRows);

    expect(coarseWindow(plans, 15_000)).toBe(true);
    expect(coarseWindow(plans, 60_000)).toBe(false);
    expect(coarseWindow([], 1_000)).toBe(false);
  });
});

describe('задержка кадра до события живого канала', () => {
  const samples = [
    reading('RC-101', '2026-09-21T10:00:00.000Z', Date.parse('2026-09-21T10:00:00.250Z')),
    reading('RC-102', '2026-09-21T10:00:01.000Z', Date.parse('2026-09-21T10:00:01.750Z')),
    reading('RC-101', '2026-09-21T10:00:02.000Z', Date.parse('2026-09-21T10:00:02.500Z')),
  ];

  it('задержка это момент приёма минус метка кадра', () => {
    expect(delaysOf(samples)).toEqual([250, 750, 500]);
  });

  it('кадры других видов в выборку задержек не попадают', () => {
    const ping: LiveSample = {
      frame: { kind: 'ping', id: '7', data: { at: '2026-09-21T10:00:03.000Z' } },
      atMs: Date.parse('2026-09-21T10:00:03.100Z'),
    };

    expect(delaysOf([...samples, ping])).toHaveLength(3);
    expect(devicesOf([...samples, ping])).toBe(2);
  });

  it('сводка берёт перцентили по существующим значениям', () => {
    const stats = delayStats(samples);

    expect(stats).toMatchObject({ count: 3, devices: 2, min: 250, max: 750 });
    expect(stats.p50).toBe(500);
    expect(stats.p95).toBe(750);
    expect(stats.p99).toBe(750);
  });

  it('пустая выборка это отсутствие цифр, а не нули', () => {
    expect(delayStats([])).toEqual({
      count: 0,
      devices: 0,
      min: null,
      p50: null,
      p95: null,
      p99: null,
      max: null,
    });
  });
});

describe('отставание потребителей', () => {
  const ends = [
    { partition: 0, low: 0, high: 100 },
    { partition: 1, low: 0, high: 50 },
    { partition: 2, low: 0, high: 10 },
  ];

  it('смещение -1 означает, что коммита не было', () => {
    expect(committedOffset('-1')).toBeNull();
    expect(committedOffset('нет')).toBeNull();
    expect(committedOffset('0')).toBe(0);
    expect(committedOffset('42')).toBe(42);
  });

  it('пустая группа шлюза это след прежнего экземпляра', () => {
    expect(isStaleGatewayGroup('fs-api-0d94630e429f-1', 'Empty')).toBe(true);
    expect(isStaleGatewayGroup('fs-api-0d94630e429f-1', 'Stable')).toBe(false);
    expect(isStaleGatewayGroup('fs-processor', 'Empty')).toBe(false);
  });

  it('отставание считается по партициям, а без коммита его нет вовсе', () => {
    const lags = partitionLags(ends, [
      { partition: 0, offset: '90' },
      { partition: 1, offset: '-1' },
    ]);

    expect(lags).toEqual([
      { partition: 0, committed: 90, high: 100, lag: 10 },
      { partition: 1, committed: null, high: 50, lag: null },
      { partition: 2, committed: null, high: 10, lag: null },
    ]);
    expect(totalLag(lags)).toBe(10);
    expect(hasCommits(lags)).toBe(true);
    expect(lagText(lags)).toBe('0: 10, 1: без коммита, 2: без коммита');
    expect(uncommittedText(lags)).toBe(
      'коммита не было в партициях 1, 2: их отставание в сумму не вошло',
    );
  });

  it('смещение впереди конца лога отставания не даёт', () => {
    const lags = partitionLags(ends, [{ partition: 0, offset: '120' }]);

    expect(lags[0]).toEqual({ partition: 0, committed: 120, high: 100, lag: 0 });
  });

  it('группа без единого коммита топик не читала', () => {
    const lags = partitionLags(ends, [{ partition: 0, offset: '-1' }]);

    expect(hasCommits(lags)).toBe(false);
    expect(totalLag(lags)).toBe(0);
    expect(uncommittedText([])).toBeNull();
  });
});
