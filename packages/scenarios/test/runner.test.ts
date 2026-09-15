import type { SimClearFaultsQuery, SimFaultRequest } from '@fieldstream/contracts';
import { createFakeClock, toIsoTimestamp } from '@fieldstream/domain';
import type { FakeClock } from '@fieldstream/domain';
import { describe, expect, it } from 'vitest';
import type { CycleOutcome, StandFacts } from '../src/facts.js';
import { runScenario } from '../src/runner.js';
import type { RunScenarioOptions, ScenarioPorts, ScenarioProgress } from '../src/runner.js';
import { scenarioSchema } from '../src/schema.js';
import type { Scenario } from '../src/schema.js';

const START = Date.UTC(2026, 8, 15, 10, 0, 0);

const scenarioOf = (steps: unknown[], timeoutSec = 600): Scenario =>
  scenarioSchema.parse({
    name: 'test-run',
    title: 'Проверка',
    description: 'Прогон на поддельных часах',
    timeoutSec,
    steps,
  });

const quietFacts = (patch: Partial<StandFacts> = {}): StandFacts => ({
  breakers: { 'RC-105': 'closed' },
  devices: { 'RC-105': { status: 'online', reason: 'ok', mode: 'cooling' } },
  lines: { L2: { connected: true, reconnects: 0, lastCycle: null } },
  activeAlarms: [],
  alarmsRaisedSinceStart: {},
  dlqTotal: 0,
  ...patch,
});

const l2Cycle = (atMs: number, durationMs: number, outcome: CycleOutcome = 'polled'): StandFacts =>
  quietFacts({
    lines: {
      L2: {
        connected: outcome !== 'disconnected',
        reconnects: 0,
        lastCycle: { at: toIsoTimestamp(atMs), outcome, durationMs },
      },
    },
  });

const openAfter = (ms: number) => (elapsed: number) =>
  quietFacts({ breakers: { 'RC-105': elapsed >= ms ? 'open' : 'closed' } });

type PortsOverride = Partial<ScenarioPorts> | ((clock: FakeClock) => Partial<ScenarioPorts>);

const harness = (factsAt: (elapsedMs: number) => StandFacts, override: PortsOverride = {}) => {
  const clock = createFakeClock(START);
  const calls = {
    inject: [] as SimFaultRequest[],
    clear: [] as SimClearFaultsQuery[],
    facts: [] as number[],
  };
  const progress: ScenarioProgress[] = [];
  const ports = typeof override === 'function' ? override(clock) : override;

  const options: RunScenarioOptions = {
    clock,
    sleep: (ms) => {
      clock.advance(ms);
      return Promise.resolve();
    },
    pollMs: 1_000,
    onProgress: (snapshot) => {
      progress.push(snapshot);
    },
    ports: {
      inject: (request) => {
        calls.inject.push(request);
        return Promise.resolve();
      },
      clear: (filter) => {
        calls.clear.push(filter);
        return Promise.resolve();
      },
      simScenario: () => Promise.resolve([]),
      facts: () => {
        const elapsed = clock.now() - START;
        calls.facts.push(elapsed);
        return Promise.resolve(factsAt(elapsed));
      },
      ...ports,
    },
  };

  return { clock, calls, progress, options, elapsed: () => clock.now() - START };
};

const slowInject =
  (ms: number) =>
  (clock: FakeClock): Partial<ScenarioPorts> => ({
    inject: () => {
      clock.advance(ms);
      return Promise.resolve();
    },
  });

const breakerOpen = { breaker: { deviceCode: 'RC-105', state: 'open' } };
const silentRc105 = { targetKind: 'device', targetId: 'RC-105', kind: 'silent' };
const silentTarget = { targetId: 'RC-105', kind: 'silent' };

describe('runScenario: waitFor', () => {
  it('проходит после нескольких опросов', async () => {
    const run = harness(openAfter(3_000));

    const result = await runScenario(
      scenarioOf([{ waitFor: { probe: breakerOpen, timeoutSec: 45 } }]),
      run.options,
    );

    expect(result.status).toBe('passed');
    expect(result.error).toBeNull();
    expect(result.steps[0]).toMatchObject({
      status: 'passed',
      title: 'Дождаться, пока размыкатель RC-105 разомкнётся, не дольше 45 с',
      detail: 'RC-105: размыкатель разомкнут',
      startedAt: '2026-09-15T10:00:00.000Z',
      finishedAt: '2026-09-15T10:00:03.000Z',
    });
    expect(run.calls.facts).toEqual([0, 0, 1_000, 2_000, 3_000]);
  });

  it('падает по таймауту с последним увиденным', async () => {
    const run = harness(() => quietFacts());

    const result = await runScenario(
      scenarioOf([{ waitFor: { probe: breakerOpen, timeoutSec: 5 } }]),
      run.options,
    );

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.detail).toBe(
      'за 5 с не дождались, последнее: RC-105: размыкатель замкнут',
    );
    expect(result.error).toBe(
      'шаг 1 «Дождаться, пока размыкатель RC-105 разомкнётся, не дольше 5 с»: за 5 с не дождались, последнее: RC-105: размыкатель замкнут',
    );
    expect(run.elapsed()).toBe(5_000);
  });
});

describe('runScenario: hold', () => {
  it('ловит нарушение на любом опросе', async () => {
    const run = harness((elapsed) => quietFacts({ dlqTotal: elapsed >= 4_000 ? 3 : 0 }));

    const result = await runScenario(
      scenarioOf([{ hold: { probe: { dlqUnchanged: true }, forSec: 20 } }]),
      run.options,
    );

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.detail).toBe(
      'нарушено через 4 с: в очереди недоставленных 3, на старте было 0, +3',
    );
  });

  it('проходит, если проба истинна всё окно', async () => {
    const run = harness(() => quietFacts({ dlqTotal: 7 }));

    const result = await runScenario(
      scenarioOf([{ hold: { probe: { dlqUnchanged: true }, forSec: 20 } }]),
      run.options,
    );

    expect(result.status).toBe('passed');
    expect(result.steps[0]?.detail).toBe(
      '20 с без нарушений: в очереди недоставленных 7, на старте было 7',
    );
    expect(run.elapsed()).toBe(20_000);
  });
});

describe('runScenario: baseline', () => {
  it('усредняет разные обходы и не считает повторы', async () => {
    const durations = [1_000, 2_000, 3_000];
    const run = harness((elapsed) => {
      const index = Math.floor(elapsed / 3_000);
      return l2Cycle(START + index * 3_000, durations[index] ?? 2_100);
    });

    const result = await runScenario(
      scenarioOf([
        { baseline: { line: 'L2', samples: 3, as: 'l2-cycle' } },
        {
          waitFor: {
            probe: { line: { lineCode: 'L2', durationWithinPct: { of: 'l2-cycle', pct: 10 } } },
            timeoutSec: 5,
          },
        },
      ]),
      run.options,
    );

    expect(result.status).toBe('passed');
    expect(result.steps.map((step) => step.detail)).toEqual([
      'L2: средний обход 2000 мс по 3 обходам (1000, 2000, 3000 мс)',
      'L2: обход 2100 мс, базовый 2000 мс, +5%',
    ]);
    expect(run.elapsed()).toBe(9_000);
  });

  it('берёт только опросные обходы, завершённые после начала шага', async () => {
    const run = harness((elapsed) => {
      if (elapsed < 1_000) return l2Cycle(START - 60_000, 9_999);
      if (elapsed < 2_000) return l2Cycle(START + 1_000, 0, 'idle');
      if (elapsed < 3_000) return l2Cycle(START + 2_000, 1_000);
      if (elapsed < 4_000) return l2Cycle(START + 3_000, 5, 'disconnected');
      return l2Cycle(START + 4_000, 2_000);
    });

    const result = await runScenario(
      scenarioOf([{ baseline: { line: 'L2', samples: 2, as: 'l2-cycle' } }]),
      run.options,
    );

    expect(result.status).toBe('passed');
    expect(result.steps[0]?.detail).toBe('L2: средний обход 1500 мс по 2 обходам (1000, 2000 мс)');
    expect(run.elapsed()).toBe(4_000);
  });

  it('падает, если новых опросных обходов нет', async () => {
    const empty = harness(() => quietFacts());
    const disconnected = harness((elapsed) =>
      l2Cycle(START + Math.floor(elapsed / 5_000) * 5_000, 0, 'disconnected'),
    );
    const scenario = scenarioOf([{ baseline: { line: 'L2', samples: 3, as: 'l2-cycle' } }]);

    const [emptyResult, disconnectedResult] = [
      await runScenario(scenario, empty.options),
      await runScenario(scenario, disconnected.options),
    ];

    expect(emptyResult.status).toBe('failed');
    expect(emptyResult.steps[0]?.detail).toBe(
      'L2: за 45 с не пришло нового опросного обхода, собрано 0 из 3',
    );
    expect(empty.elapsed()).toBe(45_000);
    expect(disconnectedResult.steps[0]?.detail).toBe(
      'L2: за 45 с не пришло нового опросного обхода, собрано 0 из 3, последний обход не опросный (порт не подключён)',
    );
  });
});

describe('runScenario: провалы и уборка', () => {
  it('провал шага пропускает остальные и снимает внесённые поломки', async () => {
    const run = harness(() => quietFacts());

    const result = await runScenario(
      scenarioOf([
        { inject: silentRc105 },
        { waitFor: { probe: breakerOpen, timeoutSec: 3 } },
        { clear: silentTarget },
      ]),
      run.options,
    );

    expect(result.status).toBe('failed');
    expect(result.steps.map((step) => step.status)).toEqual(['passed', 'failed', 'skipped']);
    expect(result.steps[0]?.title).toBe('Внести поломку «молчит» на RC-105 на 300 с');
    expect(run.calls.inject).toHaveLength(1);
    expect(run.calls.clear).toEqual([silentTarget]);
  });

  it('шаг clear вычёркивает поломку из уборки', async () => {
    const run = harness(() => quietFacts());

    const result = await runScenario(
      scenarioOf([{ inject: silentRc105 }, { clear: { targetId: 'RC-105' } }]),
      run.options,
    );

    expect(result.status).toBe('passed');
    expect(run.calls.clear).toEqual([{ targetId: 'RC-105' }]);
  });

  it('поломки сценария симулятора тоже снимаются', async () => {
    const run = harness(() => quietFacts(), {
      simScenario: () => Promise.resolve([{ targetId: 'RC-104', kind: 'door_stuck' }]),
    });

    const result = await runScenario(scenarioOf([{ simScenario: 'door-left-open' }]), run.options);

    expect(result.status).toBe('passed');
    expect(result.steps[0]?.title).toBe('Запустить сценарий стенда «дверь оставили открытой»');
    expect(run.calls.clear).toEqual([{ targetId: 'RC-104', kind: 'door_stuck' }]);
  });

  it('исключение порта это провал шага, а не падение исполнителя', async () => {
    const run = harness(() => quietFacts(), {
      inject: () => Promise.reject(new Error('стенд не отвечает')),
    });

    const result = await runScenario(
      scenarioOf([{ inject: silentRc105 }, { hold: { probe: { dlqUnchanged: true }, forSec: 5 } }]),
      run.options,
    );

    expect(result.status).toBe('failed');
    expect(result.steps.map((step) => [step.status, step.detail])).toEqual([
      ['failed', 'ошибка: стенд не отвечает'],
      ['skipped', null],
    ]);
    expect(run.calls.clear).toEqual([silentTarget]);
  });

  it('исключение порта сценария симулятора это провал шага', async () => {
    const run = harness(() => quietFacts(), {
      simScenario: () => Promise.reject(new Error('сценария нет на стенде')),
    });

    const result = await runScenario(
      scenarioOf([
        { simScenario: 'night-defrost' },
        { hold: { probe: { dlqUnchanged: true }, forSec: 5 } },
      ]),
      run.options,
    );

    expect(result.status).toBe('failed');
    expect(result.steps.map((step) => [step.status, step.detail])).toEqual([
      ['failed', 'ошибка: сценария нет на стенде'],
      ['skipped', null],
    ]);
    expect(run.calls.clear).toEqual([]);
  });

  it('сбой порта в шаге clear оставляет поломку в уборке', async () => {
    const cleared: SimClearFaultsQuery[] = [];
    const run = harness(() => quietFacts(), {
      clear: (filter) => {
        cleared.push(filter);
        return Promise.reject(new Error('стенд не отвечает'));
      },
    });

    const result = await runScenario(
      scenarioOf([{ inject: silentRc105 }, { clear: silentTarget }]),
      run.options,
    );

    expect(result.status).toBe('failed');
    expect(result.steps.map((step) => [step.status, step.detail])).toEqual([
      ['passed', 'поломка внесена, сама снимется через 300 с'],
      ['failed', 'ошибка: стенд не отвечает'],
    ]);
    expect(cleared).toEqual([silentTarget, silentTarget]);
    expect(result.error).toBe(
      'шаг 2 «Снять поломку «молчит» с RC-105»: ошибка: стенд не отвечает; уборка: поломка «молчит» на RC-105 не снята: стенд не отвечает',
    );
  });

  it('исключение порта фактов посреди ожидания это провал шага', async () => {
    let calls = 0;
    const run = harness(() => quietFacts(), {
      facts: () => {
        calls += 1;
        return calls > 2
          ? Promise.reject(new Error('база недоступна'))
          : Promise.resolve(quietFacts());
      },
    });

    const result = await runScenario(
      scenarioOf([{ waitFor: { probe: breakerOpen, timeoutSec: 10 } }]),
      run.options,
    );

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.detail).toBe('ошибка: база недоступна');
  });

  it('факты на старте не снялись: все шаги пропущены', async () => {
    const run = harness(() => quietFacts(), {
      facts: () => Promise.reject(new Error('шлюз недоступен')),
    });

    const result = await runScenario(
      scenarioOf([{ inject: silentRc105 }, { clear: {} }]),
      run.options,
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBe('не удалось снять факты стенда на старте: шлюз недоступен');
    expect(result.steps.map((step) => step.status)).toEqual(['skipped', 'skipped']);
    expect(run.calls.inject).toEqual([]);
  });

  it('ошибка уборки не превращает прогон в успех', async () => {
    const run = harness(() => quietFacts(), {
      clear: () => Promise.reject(new Error('нет связи со стендом')),
    });

    const passedSteps = await runScenario(
      scenarioOf([{ inject: silentRc105 }, { hold: { probe: { dlqUnchanged: true }, forSec: 2 } }]),
      run.options,
    );

    expect(passedSteps.steps.map((step) => step.status)).toEqual(['passed', 'passed']);
    expect(passedSteps.status).toBe('failed');
    expect(passedSteps.error).toBe(
      'уборка: поломка «молчит» на RC-105 не снята: нет связи со стендом',
    );

    const failedStep = await runScenario(
      scenarioOf([{ inject: silentRc105 }, { waitFor: { probe: breakerOpen, timeoutSec: 1 } }]),
      run.options,
    );

    expect(failedStep.status).toBe('failed');
    expect(failedStep.error).toMatch(/^шаг 2 .+; уборка: поломка «молчит» на RC-105 не снята/);
  });
});

describe('runScenario: общий timeoutSec', () => {
  it('ограничивает baseline', async () => {
    const run = harness((elapsed) => l2Cycle(START + Math.floor(elapsed / 5_000) * 5_000, 1_500));

    const result = await runScenario(
      scenarioOf(
        [
          { baseline: { line: 'L2', samples: 10, as: 'l2-cycle' } },
          { hold: { probe: { dlqUnchanged: true }, forSec: 5 } },
        ],
        20,
      ),
      run.options,
    );

    expect(result.status).toBe('failed');
    expect(result.steps.map((step) => [step.status, step.detail])).toEqual([
      ['failed', 'общий предел прогона 20 с исчерпан, последнее: L2: собрано 5 из 10'],
      ['skipped', null],
    ]);
    expect(run.elapsed()).toBe(20_000);
  });

  it('обрывает waitFor раньше его собственного срока', async () => {
    const run = harness(() => quietFacts(), slowInject(6_000));

    const result = await runScenario(
      scenarioOf(
        [{ inject: silentRc105 }, { waitFor: { probe: breakerOpen, timeoutSec: 10 } }],
        10,
      ),
      run.options,
    );

    expect(result.status).toBe('failed');
    expect(result.steps[1]?.detail).toBe(
      'общий предел прогона 10 с исчерпан, последнее: RC-105: размыкатель замкнут',
    );
    expect(run.elapsed()).toBe(10_000);
    expect(run.calls.clear).toEqual([silentTarget]);
  });

  it('обрывает hold раньше конца окна', async () => {
    const run = harness(() => quietFacts(), slowInject(6_000));

    const result = await runScenario(
      scenarioOf(
        [{ inject: silentRc105 }, { hold: { probe: { dlqUnchanged: true }, forSec: 10 } }],
        10,
      ),
      run.options,
    );

    expect(result.status).toBe('failed');
    expect(result.steps[1]?.detail).toBe(
      'общий предел прогона 10 с исчерпан, последнее: в очереди недоставленных 0, на старте было 0',
    );
    expect(run.elapsed()).toBe(10_000);
  });

  it('шаг не начинается, если предел исчерпан до него', async () => {
    const run = harness(() => quietFacts(), slowInject(11_000));

    const result = await runScenario(
      scenarioOf(
        [
          { inject: silentRc105 },
          { hold: { probe: { dlqUnchanged: true }, forSec: 5 } },
          { clear: silentTarget },
        ],
        10,
      ),
      run.options,
    );

    expect(result.status).toBe('failed');
    expect(result.steps.map((step) => [step.status, step.detail])).toEqual([
      ['passed', 'поломка внесена, сама снимется через 300 с'],
      ['failed', 'общий предел прогона 10 с исчерпан до начала шага'],
      ['skipped', null],
    ]);
    expect(run.calls.facts).toEqual([0]);
    expect(run.calls.clear).toEqual([silentTarget]);
  });
});

describe('runScenario: onProgress', () => {
  it('вызывается на каждую смену статуса шага независимыми снимками', async () => {
    const run = harness(() => quietFacts());

    const result = await runScenario(
      scenarioOf([
        { inject: silentRc105 },
        { waitFor: { probe: breakerOpen, timeoutSec: 2 } },
        { clear: silentTarget },
        { hold: { probe: { dlqUnchanged: true }, forSec: 5 } },
      ]),
      run.options,
    );

    expect(
      run.progress.map(
        (snapshot) => `${snapshot.steps.map((step) => step.status).join(',')} | ${snapshot.status}`,
      ),
    ).toEqual([
      'running,pending,pending,pending | running',
      'passed,pending,pending,pending | running',
      'passed,running,pending,pending | running',
      'passed,failed,pending,pending | running',
      'passed,failed,skipped,pending | running',
      'passed,failed,skipped,skipped | running',
      'passed,failed,skipped,skipped | failed',
    ]);
    expect(run.progress.at(-1)).toEqual(result);
    expect(run.progress[0]?.finishedAt).toBeNull();
    expect(result.finishedAt).toBe('2026-09-15T10:00:02.000Z');
  });

  it('сбой подписчика не прерывает прогон и не отменяет уборку', async () => {
    const run = harness(() => quietFacts());

    const result = await runScenario(
      scenarioOf([{ inject: silentRc105 }, { hold: { probe: { dlqUnchanged: true }, forSec: 2 } }]),
      {
        ...run.options,
        onProgress: () => {
          throw new Error('sse down');
        },
      },
    );

    expect(result.status).toBe('passed');
    expect(result.steps.map((step) => step.status)).toEqual(['passed', 'passed']);
    expect(run.calls.clear).toEqual([silentTarget]);
    expect(result.error).toBe('ход прогона не доставлен подписчику, сбоев: 5, первый: sse down');
  });
});
