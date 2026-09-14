import { describe, expect, it } from 'vitest';
import { latencyWindowSchema, lineStatusSchema, reconnectStepSchema } from '@fieldstream/contracts';
import type { LineStatus } from '@fieldstream/contracts';
import { countdownText, durationText } from '../src/features/lab/lab-format.js';
import {
  LADDER_BOX,
  histogramBars,
  histogramMarkers,
  isSnapshotStale,
  ladderBaseMs,
  ladderColumn,
  ladderSteps,
  ladderY,
  latencyX,
  probeCountdown,
  reconnectDots,
  ringDash,
  samplesMissing,
  toneOf,
  watchdogView,
} from '../src/features/lab/lab-geometry.js';
import type { BreakerSnapshot, PlotBox } from '../src/features/lab/lab-geometry.js';

const NOW_MS = Date.parse('2026-02-11T10:00:00.000Z');

const at = (offsetMs: number): string => new Date(NOW_MS + offsetMs).toISOString();

const line = (patch: Partial<LineStatus> = {}): LineStatus =>
  lineStatusSchema.parse({
    schema: 'line.status',
    v: 1,
    ts: at(0),
    lineCode: 'L1',
    running: true,
    connected: true,
    planMode: 'merged',
    pollIntervalMs: 10_000,
    requestTimeoutMs: 600,
    hardTimeoutMs: 2_000,
    watchdog: { limitMs: 10_000, cycleStartedAt: null, trips: 0 },
    lastCycle: null,
    reconnects: [],
    devices: [],
    latency: {
      bucketsMs: [25, 50],
      counts: [0, 0, 0],
      samples: 0,
      timeouts: 0,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      suggestedTimeoutMs: null,
    },
    ...patch,
  });

const breaker = (patch: Partial<BreakerSnapshot> = {}): BreakerSnapshot =>
  line({
    devices: [
      {
        deviceCode: 'RC-101',
        slaveId: 1,
        breaker: {
          state: 'open',
          failures: 2,
          probeDelayMs: 60_000,
          nextProbeAt: at(15_000),
          ...patch,
        },
      },
    ],
  }).devices[0]!.breaker;

const reconnect = (
  attempt: number,
  chosenMs: number,
): ReturnType<typeof reconnectStepSchema.parse> =>
  reconnectStepSchema.parse({
    attempt,
    at: at(-attempt * 1_000),
    baseMs: ladderBaseMs(attempt),
    jitterMs: chosenMs - ladderBaseMs(attempt),
    chosenMs,
  });

describe('отсчёт до пробы размыкателя', () => {
  it('остаток и доля кольца считаются от паузы пробы', () => {
    const countdown = probeCountdown(breaker(), NOW_MS);

    expect(countdown).toEqual({ remainingMs: 15_000, fraction: 0.25, waiting: false });

    const ring = ringDash(0.25, 16);
    expect(ring.circumference).toBeCloseTo(2 * Math.PI * 16);
    expect(ring.offset).toBeCloseTo(0.75 * 2 * Math.PI * 16);
  });

  it('наступившая проба при старом снимке это «ждёт пробы»', () => {
    expect(probeCountdown(breaker({ nextProbeAt: at(-2_000) }), NOW_MS)).toEqual({
      remainingMs: 0,
      fraction: 0,
      waiting: true,
    });
    expect(
      probeCountdown(breaker({ state: 'half_open', nextProbeAt: at(-2_000) }), NOW_MS)?.waiting,
    ).toBe(false);
  });

  it('у замкнутого размыкателя отсчёта нет', () => {
    expect(
      probeCountdown(breaker({ state: 'closed', probeDelayMs: 0, nextProbeAt: null }), NOW_MS),
    ).toBeNull();
  });

  it('доля кольца не выходит за края', () => {
    const full = ringDash(1.5);
    const empty = ringDash(-1);

    expect(full.offset).toBe(0);
    expect(empty.offset).toBeCloseTo(empty.circumference);
  });

  it('отсчёт и длительности подписываются по-человечески', () => {
    expect(countdownText(15_000)).toBe('0:15');
    expect(countdownText(272_000)).toBe('4:32');
    expect(countdownText(400)).toBe('0:01');
    expect(countdownText(-5)).toBe('0:00');
    expect(durationText(640)).toBe('640 мс');
    expect(durationText(1_000)).toBe('1 с');
    expect(durationText(3_200)).toBe('3,2 с');
    expect(durationText(12_400)).toBe('12 с');
  });
});

describe('лестница переподключения', () => {
  it('ступени 1, 2, 4, 8, 16 и 30 секунд, после пятой попытки потолок', () => {
    expect(ladderSteps().map((step) => step.baseMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
    ]);
    expect(ladderBaseMs(9)).toBe(30_000);
    expect(ladderColumn(3)).toBe(3);
    expect(ladderColumn(9)).toBe(5);
  });

  it('полоса разброса плюс-минус 10 процентов обнимает ступень', () => {
    const steps = ladderSteps();

    for (const step of steps) {
      expect(step.lowMs).toBe(Math.round(step.baseMs * 0.9));
      expect(step.highMs).toBe(Math.round(step.baseMs * 1.1));
      expect(step.bandY).toBeLessThan(step.treadY);
      expect(step.bandY + step.bandHeight).toBeGreaterThan(step.treadY);
      expect(step.bandHeight).toBeCloseTo(steps[0]!.bandHeight, 5);
    }
  });

  it('ступени стоят в столбцах одинаковой ширины и поднимаются вверх', () => {
    const steps = ladderSteps();
    const slot = (LADDER_BOX.width - LADDER_BOX.left - LADDER_BOX.right) / 6;

    steps.forEach((step, index) => {
      expect(step.x).toBeCloseTo(LADDER_BOX.left + slot * index);
      expect(step.width).toBeCloseTo(slot);
      if (index > 0) expect(step.treadY).toBeLessThan(steps[index - 1]!.treadY);
    });
    expect(ladderY(2_000) - ladderY(4_000)).toBeCloseTo(ladderY(1_000) - ladderY(2_000));
  });

  it('точка фактической задержки стоит в столбце своей попытки на высоте задержки', () => {
    const slot = (LADDER_BOX.width - LADDER_BOX.left - LADDER_BOX.right) / 6;
    const [dot] = reconnectDots([reconnect(2, 4_200)]);
    const step = ladderSteps()[2]!;

    expect(dot!.column).toBe(2);
    expect(dot!.x).toBeCloseTo(LADDER_BOX.left + slot * 2.5);
    expect(dot!.y).toBeCloseTo(ladderY(4_200));
    expect(dot!.y).toBeGreaterThan(step.bandY);
    expect(dot!.y).toBeLessThan(step.treadY);
  });

  it('попытки одного столбца раздвинуты симметрично, поздние уходят в столбец потолка', () => {
    const slot = (LADDER_BOX.width - LADDER_BOX.left - LADDER_BOX.right) / 6;
    const dots = reconnectDots([reconnect(0, 950), reconnect(0, 1_080), reconnect(7, 31_000)]);
    const center = LADDER_BOX.left + slot * 0.5;

    expect(dots[0]!.x).toBeCloseTo(center - 4);
    expect(dots[1]!.x).toBeCloseTo(center + 4);
    expect(dots[2]!.column).toBe(5);
    expect(dots[2]!.x).toBeCloseTo(LADDER_BOX.left + slot * 5.5);
  });
});

describe('сторож обхода', () => {
  it('идущий обход тикает против предела сторожа', () => {
    const snapshot = line({ watchdog: { limitMs: 10_000, cycleStartedAt: at(-4_000), trips: 1 } });

    expect(watchdogView(snapshot, NOW_MS)).toEqual({
      mode: 'cycle',
      elapsedMs: 4_000,
      limitMs: 10_000,
      fraction: 0.4,
      tone: 'normal',
      frozen: false,
    });
    expect(watchdogView(snapshot, NOW_MS + 4_000)).toMatchObject({
      fraction: 0.8,
      tone: 'warning',
    });
    expect(watchdogView(snapshot, NOW_MS + 5_500)).toMatchObject({
      fraction: 0.95,
      tone: 'danger',
    });
    expect(watchdogView(snapshot, NOW_MS + 20_000)).toMatchObject({ fraction: 1, tone: 'danger' });
  });

  it('на устаревшем снимке незавершённый обход замирает на моменте снимка', () => {
    const snapshot = line({
      ts: at(-60_000),
      watchdog: { limitMs: 10_000, cycleStartedAt: at(-63_000), trips: 0 },
    });

    expect(watchdogView(snapshot, NOW_MS, true)).toEqual({
      mode: 'cycle',
      elapsedMs: 3_000,
      limitMs: 10_000,
      fraction: 0.3,
      tone: 'normal',
      frozen: true,
    });
    expect(watchdogView(snapshot, NOW_MS + 300_000, true)).toMatchObject({
      elapsedMs: 3_000,
      frozen: true,
    });
    expect(watchdogView(snapshot, NOW_MS)).toMatchObject({ elapsedMs: 63_000, tone: 'danger' });
  });

  it('пороги цвета на 80 и 95 процентах', () => {
    expect(toneOf(0.79)).toBe('normal');
    expect(toneOf(0.8)).toBe('warning');
    expect(toneOf(0.949)).toBe('warning');
    expect(toneOf(0.95)).toBe('danger');
  });

  it('между обходами длительность последнего обхода против такта опроса', () => {
    const cycle = { at: at(-1_000), outcome: 'polled', durationMs: 2_500, polled: 12, failed: 0 };

    expect(watchdogView(line({ lastCycle: { ...cycle, outcome: 'polled' } }), NOW_MS)).toEqual({
      mode: 'last',
      elapsedMs: 2_500,
      limitMs: 10_000,
      fraction: 0.25,
      tone: 'normal',
      outcome: 'polled',
    });
    expect(
      watchdogView(line({ lastCycle: { ...cycle, outcome: 'watchdog' } }), NOW_MS),
    ).toMatchObject({ mode: 'last', tone: 'danger', outcome: 'watchdog' });
  });

  it('обход, оборванный недоступным портом, получает свой тон независимо от длительности', () => {
    const cycle = { at: at(-1_000), durationMs: 300, polled: 0, failed: 2 };

    expect(
      watchdogView(line({ lastCycle: { ...cycle, outcome: 'disconnected' } }), NOW_MS),
    ).toMatchObject({ mode: 'last', fraction: 0.03, tone: 'offline', outcome: 'disconnected' });
    expect(
      watchdogView(line({ lastCycle: { ...cycle, outcome: 'idle', durationMs: 0 } }), NOW_MS),
    ).toMatchObject({ mode: 'last', fraction: 0, tone: 'normal', outcome: 'idle' });
  });

  it('без обходов полосы нет', () => {
    expect(watchdogView(line(), NOW_MS)).toEqual({ mode: 'none' });
  });
});

describe('гистограмма времени ответа', () => {
  const box: PlotBox = { width: 140, height: 120, left: 0, right: 0, top: 20, bottom: 0 };
  const latency = latencyWindowSchema.parse({
    bucketsMs: [10, 20, 40],
    counts: [0, 5, 10, 2],
    samples: 17,
    timeouts: 1,
    p50Ms: 15,
    p95Ms: 38,
    p99Ms: 60,
    suggestedTimeoutMs: null,
  });

  it('высота столбца это доля от самой полной корзины', () => {
    const bars = histogramBars(latency, box);

    expect(bars.map((bar) => bar.height)).toEqual([0, 50, 100, 20]);
    expect(bars.map((bar) => bar.y)).toEqual([120, 70, 20, 100]);
    expect(bars.map((bar) => bar.x)).toEqual([2, 37, 72, 107]);
    expect(bars[0]!.width).toBe(31);
    expect(bars[3]).toMatchObject({ fromMs: 40, toMs: null });
  });

  it('малая корзина не пропадает, пустое окно рисует нулевые столбцы', () => {
    const small = histogramBars({ bucketsMs: [10, 20, 40], counts: [1, 1_000, 0, 0] }, box);
    const empty = histogramBars({ bucketsMs: [10, 20, 40], counts: [0, 0, 0, 0] }, box);

    expect(small[0]!.height).toBe(2);
    expect(empty.every((bar) => bar.height === 0)).toBe(true);
  });

  it('время ложится внутрь своей корзины, далеко за краем упирается в правый край', () => {
    const bounds = latency.bucketsMs;

    expect(latencyX(5, bounds, box)).toEqual({ x: 17.5, clamped: false });
    expect(latencyX(15, bounds, box)).toEqual({ x: 52.5, clamped: false });
    expect(latencyX(40, bounds, box)).toEqual({ x: 105, clamped: false });
    expect(latencyX(60, bounds, box)).toEqual({ x: 122.5, clamped: false });
    expect(latencyX(100, bounds, box)).toEqual({ x: 140, clamped: true });
  });

  it('метки перцентилей и таймаутов стоят на своих временах и не наезжают подписями', () => {
    const markers = histogramMarkers(latency, 30, box);
    const byKind = Object.fromEntries(markers.map((marker) => [marker.kind, marker]));

    expect(markers.map((marker) => marker.kind)).toEqual(['p50', 'timeout', 'p95', 'p99']);
    expect(byKind['p50']).toMatchObject({ x: 52.5, row: 0, labelY: 12 });
    expect(byKind['timeout']).toMatchObject({ x: 87.5, row: 1, labelY: 25 });
    expect(byKind['p95']!.x).toBeCloseTo(101.5);
    expect(byKind['p95']!.row).toBe(0);
    expect(byKind['p99']).toMatchObject({ x: 122.5, row: 2, labelX: 118 });
    expect(byKind['suggested']).toBeUndefined();
  });

  it('таймауты за последней границей корзин упираются в край, подписи не слипаются', () => {
    const wide = latencyWindowSchema.parse({
      bucketsMs: [100, 400, 1_200],
      counts: [50, 60, 30, 10],
      samples: 150,
      timeouts: 3,
      p50Ms: 80,
      p95Ms: 900,
      p99Ms: 1_500,
      suggestedTimeoutMs: 2_500,
    });
    const markers = histogramMarkers(wide, 3_000, box);
    const byKind = Object.fromEntries(markers.map((marker) => [marker.kind, marker]));

    expect(markers.map((marker) => marker.kind)).toEqual([
      'p50',
      'p95',
      'p99',
      'suggested',
      'timeout',
    ]);
    expect(byKind['p50']).toMatchObject({ x: 28, clamped: false, row: 0, labelX: 28 });
    expect(byKind['p95']!.x).toBeCloseTo(91.875);
    expect(byKind['p99']).toMatchObject({ x: 113.75, clamped: false, row: 1 });
    expect(byKind['suggested']).toMatchObject({ x: 140, clamped: true, row: 0, labelX: 118 });
    expect(byKind['timeout']).toMatchObject({
      x: 140,
      clamped: true,
      row: 2,
      labelX: 118,
      labelY: 38,
    });
  });

  it('рекомендация таймаута ждёт сотни замеров', () => {
    expect(samplesMissing(40)).toBe(60);
    expect(samplesMissing(100)).toBe(0);
    expect(samplesMissing(250)).toBe(0);
  });
});

describe('устаревание снимка линии', () => {
  it('снимок старше 30 секунд по серверным часам устарел', () => {
    expect(isSnapshotStale(at(-30_000), NOW_MS)).toBe(false);
    expect(isSnapshotStale(at(-30_001), NOW_MS)).toBe(true);
    expect(isSnapshotStale('не время', NOW_MS)).toBe(true);
  });
});
