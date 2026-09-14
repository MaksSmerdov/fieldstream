import type {
  SimClearFaultsQuery,
  SimFaultKind,
  SimFaultRequest,
  SimScenarioName,
} from '@fieldstream/contracts';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import { evaluateProbe } from './facts.js';
import type { ProbeContext, StandFacts } from './facts.js';
import type { Scenario, ScenarioStep, StepKind, StepOf } from './schema.js';
import { CYCLE_OUTCOME_WORDS, describeStep, FAULT_NAMES } from './titles.js';

/** Поломка, которую прогон внёс и обязан снять в конце. */
export interface FaultTarget {
  readonly targetId: string;
  readonly kind: SimFaultKind;
}

/**
 * Всё внешнее, до чего дотягивается прогон. simScenario возвращает поломки,
 * которые внёс сценарий симулятора, чтобы прогон убрал и их.
 */
export interface ScenarioPorts {
  readonly inject: (request: SimFaultRequest) => Promise<unknown>;
  readonly clear: (filter: SimClearFaultsQuery) => Promise<unknown>;
  readonly simScenario: (name: SimScenarioName) => Promise<readonly FaultTarget[]>;
  readonly facts: (startedAt: string) => Promise<StandFacts>;
}

/** Статус шага в ходе прогона. */
export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

/** Шаг в результате прогона. */
export interface StepResult {
  index: number;
  kind: StepKind;
  title: string;
  status: StepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  detail: string | null;
}

/** Итог прогона. */
export type ScenarioStatus = 'passed' | 'failed';

/** Снимок хода прогона для onProgress: пока прогон идёт, статус running и finishedAt пуст. */
export interface ScenarioProgress {
  name: string;
  title: string;
  status: 'running' | ScenarioStatus;
  startedAt: string;
  finishedAt: string | null;
  steps: StepResult[];
  error: string | null;
}

/**
 * Результат прогона. status решают только шаги и уборка. В error причины провала и, если были,
 * сбои доставки хода прогона: они статус не меняют.
 */
export interface ScenarioResult extends ScenarioProgress {
  status: ScenarioStatus;
  finishedAt: string;
}

/** Настройки прогона: время и ожидание приходят снаружи. */
export interface RunScenarioOptions {
  readonly ports: ScenarioPorts;
  readonly clock: Clock;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  readonly baselineIdleMs?: number;
  readonly onProgress?: (progress: ScenarioProgress) => void;
}

/** Период опроса фактов по умолчанию. */
export const DEFAULT_POLL_MS = 1_000;

/** Сколько ждать нового обхода при снятии базовой длительности: три такта по 15 с. */
export const BASELINE_IDLE_MS = 45_000;

/** Состояние прогона, общее для шагов. */
interface RunState {
  readonly ports: ScenarioPorts;
  readonly clock: Clock;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs: number;
  readonly idleMs: number;
  readonly deadline: number;
  readonly timeoutSec: number;
  readonly startedAt: string;
  readonly baselines: Record<string, number>;
  readonly context: ProbeContext;
  readonly injected: Map<string, FaultTarget>;
}

/** Итог одного шага. */
interface StepOutcome {
  readonly ok: boolean;
  readonly detail: string;
}

/** Текст исключения порта. */
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Миллисекунды в целые секунды. */
const seconds = (ms: number): number => Math.round(ms / 1000);

/** Ключ поломки для учёта уборки. */
const faultKey = (target: FaultTarget): string => `${target.targetId}/${target.kind}`;

/** Провал по общему пределу прогона. */
const overallTimeout = (run: RunState, observed: string): StepOutcome => ({
  ok: false,
  detail: `общий предел прогона ${run.timeoutSec} с исчерпан, последнее: ${observed}`,
});

/** Вносит поломку и сразу берёт её на учёт для уборки. */
const runInject = async (step: StepOf<'inject'>, run: RunState): Promise<StepOutcome> => {
  const { request } = step;
  const target: FaultTarget = { targetId: request.targetId, kind: request.kind };

  run.injected.set(faultKey(target), target);
  await run.ports.inject(request);

  return { ok: true, detail: `поломка внесена, сама снимется через ${request.ttlSec} с` };
};

/** Снимает поломки по фильтру и вычёркивает их из уборки. */
const runClear = async (step: StepOf<'clear'>, run: RunState): Promise<StepOutcome> => {
  const { targetId, kind } = step.filter;

  await run.ports.clear(step.filter);
  for (const [key, target] of run.injected) {
    if (
      (targetId === undefined || targetId === target.targetId) &&
      (kind === undefined || kind === target.kind)
    ) {
      run.injected.delete(key);
    }
  }

  return { ok: true, detail: 'поломки сняты' };
};

/** Запускает сценарий симулятора и берёт на учёт его поломки. */
const runSimScenario = async (step: StepOf<'simScenario'>, run: RunState): Promise<StepOutcome> => {
  const created = await run.ports.simScenario(step.name);

  for (const target of created) {
    run.injected.set(faultKey(target), { targetId: target.targetId, kind: target.kind });
  }

  return {
    ok: true,
    detail:
      created.length === 0
        ? 'сценарий запущен'
        : `сценарий запущен, внесено поломок: ${created.length}`,
  };
};

/**
 * Снимает среднюю длительность обхода по разным опросным обходам, завершённым после начала шага.
 * Простой, обрыв порта и сработка сторожа в среднее не идут.
 */
const runBaseline = async (step: StepOf<'baseline'>, run: RunState): Promise<StepOutcome> => {
  const stepStartedMs = run.clock.now();
  const seen = new Set<string>();
  const durations: number[] = [];
  let lastNewAt = stepStartedMs;
  let lastSkipped: string | null = null;

  for (;;) {
    const facts = await run.ports.facts(run.startedAt);
    const line = facts.lines[step.line];
    const cycle = line?.lastCycle ?? null;

    if (cycle !== null && !seen.has(cycle.at)) {
      seen.add(cycle.at);
      if (cycle.outcome !== 'polled') {
        lastSkipped = CYCLE_OUTCOME_WORDS[cycle.outcome];
      } else if (Date.parse(cycle.at) >= stepStartedMs) {
        durations.push(cycle.durationMs);
        lastNewAt = run.clock.now();
      }
    }

    if (durations.length >= step.samples) {
      const average = durations.reduce((sum, value) => sum + value, 0) / durations.length;
      run.baselines[step.as] = average;
      return {
        ok: true,
        detail: `${step.line}: средний обход ${Math.round(average)} мс по ${durations.length} обходам (${durations.join(', ')} мс)`,
      };
    }

    const collected = `собрано ${durations.length} из ${step.samples}`;
    const now = run.clock.now();

    if (now - lastNewAt >= run.idleMs) {
      const missing = line === undefined ? ', линии нет в снимке стенда' : '';
      const skipped = lastSkipped === null ? '' : `, последний обход не опросный (${lastSkipped})`;
      return {
        ok: false,
        detail: `${step.line}: за ${seconds(run.idleMs)} с не пришло нового опросного обхода, ${collected}${missing}${skipped}`,
      };
    }
    if (now >= run.deadline) return overallTimeout(run, `${step.line}: ${collected}`);

    await run.sleep(Math.min(run.pollMs, lastNewAt + run.idleMs - now, run.deadline - now));
  }
};

/** Опрашивает факты, пока проба не станет истинной или не выйдет время. */
const runWaitFor = async (step: StepOf<'waitFor'>, run: RunState): Promise<StepOutcome> => {
  const ownEnd = run.clock.now() + step.timeoutSec * 1000;
  const end = Math.min(ownEnd, run.deadline);

  for (;;) {
    const facts = await run.ports.facts(run.startedAt);
    const outcome = evaluateProbe(step.probe, facts, run.context);
    if (outcome.ok) return { ok: true, detail: outcome.observed };

    const now = run.clock.now();
    if (now >= end) {
      return ownEnd > run.deadline
        ? overallTimeout(run, outcome.observed)
        : {
            ok: false,
            detail: `за ${step.timeoutSec} с не дождались, последнее: ${outcome.observed}`,
          };
    }

    await run.sleep(Math.min(run.pollMs, end - now));
  }
};

/** Проверяет, что проба истинна на каждом опросе в течение forSec. */
const runHold = async (step: StepOf<'hold'>, run: RunState): Promise<StepOutcome> => {
  const startedMs = run.clock.now();
  const end = startedMs + step.forSec * 1000;

  for (;;) {
    const facts = await run.ports.facts(run.startedAt);
    const outcome = evaluateProbe(step.probe, facts, run.context);
    const now = run.clock.now();

    if (!outcome.ok) {
      return {
        ok: false,
        detail: `нарушено через ${seconds(now - startedMs)} с: ${outcome.observed}`,
      };
    }
    if (now >= end)
      return { ok: true, detail: `${step.forSec} с без нарушений: ${outcome.observed}` };
    if (now >= run.deadline) return overallTimeout(run, outcome.observed);

    await run.sleep(Math.min(run.pollMs, end - now, run.deadline - now));
  }
};

/** Исполняет шаг по его виду. */
const executeStep = (step: ScenarioStep, run: RunState): Promise<StepOutcome> => {
  switch (step.kind) {
    case 'inject':
      return runInject(step, run);
    case 'clear':
      return runClear(step, run);
    case 'simScenario':
      return runSimScenario(step, run);
    case 'baseline':
      return runBaseline(step, run);
    case 'waitFor':
      return runWaitFor(step, run);
    case 'hold':
      return runHold(step, run);
  }
};

/** Исполняет шаг, превращая исключение порта в провал шага. */
const attemptStep = async (step: ScenarioStep, run: RunState): Promise<StepOutcome> => {
  try {
    return await executeStep(step, run);
  } catch (error) {
    return { ok: false, detail: `ошибка: ${errorMessage(error)}` };
  }
};

/** Снимает все поломки, внесённые прогоном. Возвращает тексты неудач. */
const cleanUp = async (
  ports: ScenarioPorts,
  injected: Map<string, FaultTarget>,
): Promise<string[]> => {
  const issues: string[] = [];

  for (const target of injected.values()) {
    try {
      await ports.clear({ targetId: target.targetId, kind: target.kind });
    } catch (error) {
      issues.push(
        `поломка «${FAULT_NAMES[target.kind]}» на ${target.targetId} не снята: ${errorMessage(error)}`,
      );
    }
  }

  return issues;
};

/**
 * Прогоняет сценарий стенда. Не бросает: провал шага, исключение порта, общий предел и сбой
 * onProgress попадают в результат. Поломки, внесённые прогоном, снимаются при любом исходе.
 */
export const runScenario = async (
  scenario: Scenario,
  options: RunScenarioOptions,
): Promise<ScenarioResult> => {
  const { ports, clock, sleep, onProgress } = options;
  const startedMs = clock.now();
  const startedAt = toIsoTimestamp(startedMs);
  const injected = new Map<string, FaultTarget>();
  const failures: string[] = [];
  let progressFailures = 0;
  let firstProgressError = '';

  const plan = scenario.steps.map((step, index) => {
    const entry: StepResult = {
      index,
      kind: step.kind,
      title: describeStep(step),
      status: 'pending',
      startedAt: null,
      finishedAt: null,
      detail: null,
    };
    return { step, entry };
  });

  const progress: ScenarioProgress = {
    name: scenario.name,
    title: scenario.title,
    status: 'running',
    startedAt,
    finishedAt: null,
    steps: plan.map(({ entry }) => entry),
    error: null,
  };

  const emit = (): void => {
    if (onProgress === undefined) return;
    try {
      onProgress(structuredClone(progress));
    } catch (error) {
      if (progressFailures === 0) firstProgressError = errorMessage(error);
      progressFailures += 1;
    }
  };
  const nowIso = (): string => toIsoTimestamp(clock.now());

  try {
    const initial = await ports.facts(startedAt);
    const baselines: Record<string, number> = {};
    const run: RunState = {
      ports,
      clock,
      sleep,
      pollMs: options.pollMs ?? DEFAULT_POLL_MS,
      idleMs: options.baselineIdleMs ?? BASELINE_IDLE_MS,
      deadline: startedMs + scenario.timeoutSec * 1000,
      timeoutSec: scenario.timeoutSec,
      startedAt,
      baselines,
      context: { baselines, dlqAtStart: initial.dlqTotal },
      injected,
    };

    for (const { step, entry } of plan) {
      entry.status = 'running';
      entry.startedAt = nowIso();
      emit();

      const outcome =
        clock.now() >= run.deadline
          ? {
              ok: false,
              detail: `общий предел прогона ${scenario.timeoutSec} с исчерпан до начала шага`,
            }
          : await attemptStep(step, run);

      entry.status = outcome.ok ? 'passed' : 'failed';
      entry.finishedAt = nowIso();
      entry.detail = outcome.detail;
      emit();

      if (!outcome.ok) {
        failures.push(`шаг ${entry.index + 1} «${entry.title}»: ${outcome.detail}`);
        break;
      }
    }
  } catch (error) {
    const stage = plan.some(({ entry }) => entry.status !== 'pending')
      ? 'прогон прерван'
      : 'не удалось снять факты стенда на старте';
    failures.push(`${stage}: ${errorMessage(error)}`);
  }

  for (const entry of progress.steps) {
    if (entry.status === 'running') {
      entry.status = 'failed';
      entry.detail = 'шаг прерван сбоем прогона';
      emit();
    } else if (entry.status === 'pending') {
      entry.status = 'skipped';
      emit();
    }
  }

  const cleanupIssues = await cleanUp(ports, injected);
  if (cleanupIssues.length > 0) failures.push(`уборка: ${cleanupIssues.join('; ')}`);

  const result: ScenarioResult = {
    ...progress,
    status: failures.length === 0 ? 'passed' : 'failed',
    finishedAt: nowIso(),
    error: failures.length === 0 ? null : failures.join('; '),
  };
  Object.assign(progress, result);
  emit();

  if (progressFailures === 0) return structuredClone(result);

  const note = `ход прогона не доставлен подписчику, сбоев: ${progressFailures}, первый: ${firstProgressError}`;
  return {
    ...structuredClone(result),
    error: result.error === null ? note : `${result.error}; ${note}`,
  };
};
