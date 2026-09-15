import { describe, expect, it } from 'vitest';
import type { LineStatus, ScenarioRun, ScenarioRunStep } from '@fieldstream/contracts';
import { scenarioSchema } from '@fieldstream/scenarios';
import {
  busyMessage,
  closeSteps,
  faultTargetsOf,
  isLineSnapshotFresh,
  lineFactsOf,
  planSteps,
} from '../src/scenarios/scenario-calc.js';

const TS = '2026-09-15T10:00:00.000Z';

const line = (patch: Partial<LineStatus>): LineStatus => ({
  schema: 'line.status',
  v: 1,
  ts: TS,
  lineCode: 'L2',
  running: true,
  connected: true,
  planMode: 'merged',
  pollIntervalMs: 10_000,
  requestTimeoutMs: 600,
  hardTimeoutMs: 1_450,
  watchdog: { limitMs: 300_000, cycleStartedAt: null, trips: 0 },
  lastCycle: { at: TS, outcome: 'polled', durationMs: 420, polled: 6, failed: 0 },
  reconnects: [],
  devices: [
    {
      deviceCode: 'RC-105',
      slaveId: 5,
      breaker: { state: 'open', failures: 2, probeDelayMs: 5_000, nextProbeAt: null },
    },
  ],
  latency: {
    bucketsMs: [50],
    counts: [1, 0],
    samples: 1,
    timeouts: 0,
    p50Ms: 40,
    p95Ms: 40,
    p99Ms: 40,
    suggestedTimeoutMs: null,
  },
  ...patch,
});

const reconnect = (at: string) => ({ attempt: 1, at, baseMs: 1_000, jitterMs: 0, chosenMs: 1_000 });

describe('факты линий для прогона', () => {
  it('размыкатели собираются со всех линий, попытки переподключения только с начала прогона', () => {
    const facts = lineFactsOf(
      [
        line({}),
        line({
          lineCode: 'L3',
          connected: false,
          lastCycle: null,
          reconnects: [
            reconnect('2026-09-15T09:59:00.000Z'),
            reconnect('2026-09-15T10:00:05.000Z'),
          ],
          devices: [
            {
              deviceCode: 'RC-107',
              slaveId: 1,
              breaker: { state: 'closed', failures: 0, probeDelayMs: 0, nextProbeAt: null },
            },
          ],
        }),
      ],
      TS,
      Date.parse(TS) + 5_000,
    );

    expect(facts).toEqual({
      breakers: { 'RC-105': 'open', 'RC-107': 'closed' },
      lines: {
        L2: {
          connected: true,
          reconnects: 0,
          lastCycle: { at: TS, outcome: 'polled', durationMs: 420 },
        },
        L3: { connected: false, reconnects: 1, lastCycle: null },
      },
    });
  });

  it('устаревший снимок выпадает вместе с размыкателями: зависший сборщик не подтверждает пробы', () => {
    const nowMs = Date.parse(TS) + 61_000;
    const facts = lineFactsOf(
      [
        line({}),
        line({
          lineCode: 'L4',
          ts: '2026-09-15T10:00:50.000Z',
          devices: [
            {
              deviceCode: 'RC-110',
              slaveId: 1,
              breaker: { state: 'closed', failures: 0, probeDelayMs: 0, nextProbeAt: null },
            },
          ],
        }),
      ],
      TS,
      nowMs,
    );

    expect(facts).toEqual({
      breakers: { 'RC-110': 'closed' },
      lines: { L4: { connected: true, reconnects: 0, lastCycle: expect.anything() as unknown } },
    });
  });

  it('снимок свежий не меньше минуты и не меньше трёх тактов опроса', () => {
    const at = Date.parse(TS);

    expect(isLineSnapshotFresh(line({}), at + 60_000)).toBe(true);
    expect(isLineSnapshotFresh(line({}), at + 60_001)).toBe(false);
    expect(isLineSnapshotFresh(line({ pollIntervalMs: 30_000 }), at + 90_000)).toBe(true);
    expect(isLineSnapshotFresh(line({ pollIntervalMs: 30_000 }), at + 90_001)).toBe(false);
  });
});

describe('поломки сценария симулятора', () => {
  it('снимать нужно только поломки: оттайка и отказы стенда в уборку не идут', () => {
    expect(
      faultTargetsOf([
        {
          outcome: 'fault',
          fault: {
            id: 'f-1',
            targetKind: 'line',
            targetId: 'L2',
            kind: 'offline',
            since: TS,
            expiresAt: TS,
            exceptionCode: null,
            paramKey: null,
          },
        },
        { outcome: 'action', action: 'defrost_started', deviceCode: 'RC-101' },
        { outcome: 'rejected', status: 422, message: 'неприменима' },
      ]),
    ).toEqual([{ targetId: 'L2', kind: 'offline' }]);
  });
});

describe('ход прогона', () => {
  it('план шагов берёт заголовки сценария, все шаги ещё не начаты', () => {
    const scenario = scenarioSchema.parse({
      name: 'breaker-trip',
      title: 'Размыкатель',
      description: 'Проверка',
      timeoutSec: 30,
      steps: [
        { inject: { targetKind: 'device', targetId: 'RC-105', kind: 'silent', ttlSec: 60 } },
        { clear: { targetId: 'RC-105', kind: 'silent' } },
      ],
    });

    expect(planSteps(scenario)).toEqual([
      {
        index: 0,
        kind: 'inject',
        title: 'Внести поломку «молчит» на RC-105 на 60 с',
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        detail: null,
      },
      {
        index: 1,
        kind: 'clear',
        title: 'Снять поломку «молчит» с RC-105',
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        detail: null,
      },
    ]);
  });

  it('брошенный ход закрывается: шаг в работе провален, не начатые пропущены', () => {
    const base: ScenarioRunStep = {
      index: 0,
      kind: 'inject',
      title: 'Шаг',
      status: 'passed',
      startedAt: TS,
      finishedAt: TS,
      detail: 'внесена',
    };
    const at = '2026-09-15T10:01:00.000Z';

    expect(
      closeSteps(
        [
          base,
          { ...base, index: 1, status: 'running', finishedAt: null, detail: null },
          { ...base, index: 2, status: 'pending', startedAt: null, finishedAt: null, detail: null },
        ],
        at,
        'шлюз останавливается',
      ).map((step) => [step.status, step.finishedAt, step.detail]),
    ).toEqual([
      ['passed', TS, 'внесена'],
      ['failed', at, 'шлюз останавливается'],
      ['skipped', null, null],
    ]);
  });

  it('занятый стенд называет идущий прогон и того, кто его запустил', () => {
    const active = { title: 'Мёртвый прибор', requestedBy: 'engineer@fieldstream.local' };

    expect(busyMessage(active as ScenarioRun)).toBe(
      'на стенде идёт прогон «Мёртвый прибор», его запустил engineer@fieldstream.local: дождитесь итога и повторите запуск',
    );
    expect(busyMessage(null)).toBe(
      'на стенде уже идёт другой прогон сценария, повторите запуск позже',
    );
  });
});
