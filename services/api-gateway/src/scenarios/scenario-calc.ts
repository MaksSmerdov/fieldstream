import type {
  BreakerState,
  LineStatus,
  ScenarioRun,
  ScenarioRunStep,
  SimScenarioResult,
} from '@fieldstream/contracts';
import { countReconnectsSince, describeStep } from '@fieldstream/scenarios';
import type { FaultTarget, LineFacts, Scenario, StandFacts } from '@fieldstream/scenarios';

/** План шагов нового прогона: все шаги ещё не начаты. */
export const planSteps = (scenario: Scenario): ScenarioRunStep[] =>
  scenario.steps.map((step, index) => ({
    index,
    kind: step.kind,
    title: describeStep(step),
    status: 'pending',
    startedAt: null,
    finishedAt: null,
    detail: null,
  }));

/** Нижний предел возраста живого снимка: без связи сборщик публикует снимок раз в паузу переподключения, до 33 с. */
export const STALE_LINE_MIN_MS = 60_000;

/** Сколько тактов опроса снимок линии остаётся свежим. */
export const STALE_LINE_CYCLES = 3;

/** Снимок линии свежий: сборщик публиковал его недавно, а не завис и не остался от прошлого запуска стенда. */
export const isLineSnapshotFresh = (line: LineStatus, nowMs: number): boolean =>
  nowMs - Date.parse(line.ts) <=
  Math.max(STALE_LINE_MIN_MS, line.pollIntervalMs * STALE_LINE_CYCLES);

/**
 * Размыкатели и линии по последним снимкам сборщика. Устаревшая линия выпадает вместе с
 * размыкателями: проба по ней не подтверждается. Попытки переподключения только с начала прогона.
 */
export const lineFactsOf = (
  lines: readonly LineStatus[],
  startedAt: string,
  nowMs: number,
): Pick<StandFacts, 'breakers' | 'lines'> => {
  const breakers: Record<string, BreakerState> = {};
  const facts: Record<string, LineFacts> = {};

  for (const line of lines.filter((item) => isLineSnapshotFresh(item, nowMs))) {
    facts[line.lineCode] = {
      connected: line.connected,
      reconnects: countReconnectsSince(line.reconnects, startedAt),
      lastCycle:
        line.lastCycle === null
          ? null
          : {
              at: line.lastCycle.at,
              outcome: line.lastCycle.outcome,
              durationMs: line.lastCycle.durationMs,
            },
    };
    for (const device of line.devices) breakers[device.deviceCode] = device.breaker.state;
  }

  return { breakers, lines: facts };
};

/** Поломки, внесённые сценарием симулятора: разовые действия и отказы снимать нечего. */
export const faultTargetsOf = (results: readonly SimScenarioResult[]): FaultTarget[] =>
  results.flatMap((result) =>
    result.outcome === 'fault'
      ? [{ targetId: result.fault.targetId, kind: result.fault.kind }]
      : [],
  );

/** Закрывает брошенный ход: шаг в работе проваливается с причиной, не начатые пропускаются. */
export const closeSteps = (
  steps: readonly ScenarioRunStep[],
  at: string,
  detail: string,
): ScenarioRunStep[] =>
  steps.map((step) => {
    if (step.status === 'running') return { ...step, status: 'failed', finishedAt: at, detail };
    if (step.status === 'pending') return { ...step, status: 'skipped' };
    return step;
  });

/** Почему стенд занят: какой прогон идёт и кто его запустил. */
export const busyMessage = (active: ScenarioRun | null): string =>
  active === null
    ? 'на стенде уже идёт другой прогон сценария, повторите запуск позже'
    : `на стенде идёт прогон «${active.title}», его запустил ${active.requestedBy}: дождитесь итога и повторите запуск`;
