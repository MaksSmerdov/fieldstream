import { appendFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { scenarioRunSchema, scenariosResponseSchema } from '@fieldstream/contracts';
import type { ScenarioRun, ScenarioStepStatus, ScenarioSummary } from '@fieldstream/contracts';
import { SystemClock } from '@fieldstream/domain';
import { parseConfig, selectScenarios } from './config.js';
import {
  CLOCK_SLACK_MS,
  POLL_MS,
  decide,
  isAmbiguous,
  isFinished,
  messageOf,
  ownActiveRun,
  resultLimitMs,
} from './decide.js';
import type { RequestPhase } from './decide.js';
import { createGatewayClient, errorText } from './gateway.js';
import type { GatewayClient } from './gateway.js';
import { changedSteps, durationMsOf, formatSummary, outcomeLine, stepLine } from './report.js';
import type { ScenarioOutcome } from './report.js';

const LIST_LIMIT_MS = 60_000;

type CallResult =
  { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly reason: string };

/**
 * Запрос к шлюзу и правила повтора. recover ищет, чем закончился запрос, ответ на который
 * потерялся: найденное принимается вместо повтора.
 */
interface CallSpec {
  readonly phase: RequestPhase;
  readonly limitMs: number;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly waitConflicts?: boolean;
  readonly recover?: () => Promise<unknown>;
}

/** Как закончилась попытка: прогон доигран, остался без итога или не запускался. */
type AttemptState = 'finished' | 'unfinished' | 'not-started';

interface AttemptResult {
  readonly outcome: ScenarioOutcome;
  readonly state: AttemptState;
}

/** Настройки попытки: учётка, ожидание занятого стенда и сдвиг часов шлюза от часов CI. */
interface AttemptOptions {
  readonly email: string;
  readonly conflictLimitMs: number;
  readonly waitConflicts: boolean;
  readonly serverOffsetMs: number;
}

/** Что уже известно о прогоне сценариев: нужно и для сводки при аварийном завершении. */
interface CiState {
  summaryPath: string | null;
  readonly outcomes: ScenarioOutcome[];
}

/** Строка журнала CI. */
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** Запрос с повторами по решению decide: вход заново, ожидание занятого стенда, сбои сети. */
const call = async (gateway: GatewayClient, spec: CallSpec): Promise<CallResult> => {
  const startedMs = SystemClock.now();
  let reloggedIn = false;
  let uncertain = false;

  for (;;) {
    const reply = await gateway.request(spec.method, spec.path, spec.body);
    const message = messageOf(reply.body) ?? reply.error;
    const decision = decide(reply.status, {
      phase: spec.phase,
      reloggedIn,
      elapsedMs: SystemClock.now() - startedMs,
      limitMs: spec.limitMs,
      waitConflicts: spec.waitConflicts ?? true,
    });
    if (isAmbiguous(reply.status)) uncertain = true;

    if (
      uncertain &&
      spec.recover !== undefined &&
      (decision.kind === 'wait' || decision.kind === 'fail')
    ) {
      const recovered = await spec.recover();
      if (recovered !== null) return { ok: true, body: recovered };
    }

    switch (decision.kind) {
      case 'accept':
        return { ok: true, body: reply.body };
      case 'relogin':
        try {
          await gateway.login();
        } catch (error) {
          return { ok: false, reason: errorText(error) };
        }
        reloggedIn = true;
        break;
      case 'wait':
        say(
          `  ${decision.reason}${message === null ? '' : ` (${message})`}, повтор через ${decision.ms / 1000} с`,
        );
        reloggedIn = false;
        await delay(decision.ms);
        break;
      case 'fail':
        return {
          ok: false,
          reason: message === null ? decision.reason : `${decision.reason}: ${message}`,
        };
    }
  }
};

/** Запускает прогон, печатает ход шагов и дожидается итога с пределом. */
const attempt = async (
  gateway: GatewayClient,
  scenario: ScenarioSummary,
  options: AttemptOptions,
): Promise<AttemptResult> => {
  const failed = (
    state: AttemptState,
    error: string,
    durationMs: number | null = null,
  ): AttemptResult => ({
    outcome: { name: scenario.name, title: scenario.title, passed: false, durationMs, error },
    state,
  });

  const notBeforeMs = SystemClock.now() + options.serverOffsetMs - CLOCK_SLACK_MS;
  const recover = async (): Promise<ScenarioRun | null> => {
    const reply = await gateway.request('GET', '/api/scenarios');
    const listed = reply.status === 200 ? scenariosResponseSchema.safeParse(reply.body) : null;
    if (listed === null || !listed.success) return null;

    const own = ownActiveRun(listed.data, {
      scenario: scenario.name,
      email: options.email,
      notBeforeMs,
    });
    if (own !== null) say(`  ответ на запуск потерялся, но прогон ${own.id} создан: следим за ним`);
    return own;
  };

  const started = await call(gateway, {
    phase: 'start',
    limitMs: options.conflictLimitMs,
    method: 'POST',
    path: `/api/scenarios/${scenario.name}/run`,
    body: { source: 'ci' },
    waitConflicts: options.waitConflicts,
    recover,
  });
  if (!started.ok) return failed('not-started', `прогон не запущен: ${started.reason}`);

  const initial = scenarioRunSchema.safeParse(started.body);
  if (!initial.success) return failed('unfinished', 'шлюз вернул прогон не по контракту');

  let run = initial.data;
  const seen = new Map<number, ScenarioStepStatus>();
  const startedMs = SystemClock.now();
  const limitMs = resultLimitMs(scenario.timeoutSec);
  say(`  прогон ${run.id}`);

  while (!isFinished(run.status)) {
    const elapsedMs = SystemClock.now() - startedMs;
    if (elapsedMs >= limitMs) {
      return failed(
        'unfinished',
        `итог прогона не пришёл за ${Math.round(limitMs / 1000)} с`,
        elapsedMs,
      );
    }

    await delay(POLL_MS);
    const reply = await call(gateway, {
      phase: 'read',
      limitMs: Math.max(limitMs - elapsedMs, POLL_MS),
      method: 'GET',
      path: `/api/scenario-runs/${run.id}`,
    });
    if (!reply.ok) {
      return failed('unfinished', `ход прогона не читается: ${reply.reason}`, elapsedMs);
    }

    const parsed = scenarioRunSchema.safeParse(reply.body);
    if (!parsed.success) {
      return failed('unfinished', 'шлюз вернул ход прогона не по контракту', elapsedMs);
    }

    run = parsed.data;
    for (const step of changedSteps(seen, run.steps)) {
      say(`  ${stepLine(scenario.name, step, run.steps.length)}`);
      seen.set(step.index, step.status);
    }
  }

  return {
    outcome: {
      name: scenario.name,
      title: scenario.title,
      passed: run.status === 'passed',
      durationMs: durationMsOf(run),
      error: run.error,
    },
    state: 'finished',
  };
};

/** Прогоняет сценарии по очереди и возвращает код выхода. */
const main = async (state: CiState): Promise<number> => {
  const parsed = parseConfig(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    throw new Error(`неверные настройки\n${parsed.issues.map((issue) => `  ${issue}`).join('\n')}`);
  }

  const { config } = parsed;
  state.summaryPath = config.summaryPath;
  const gateway = createGatewayClient(config.baseUrl, config);
  await gateway.login();

  const listed = await call(gateway, {
    phase: 'read',
    limitMs: LIST_LIMIT_MS,
    method: 'GET',
    path: '/api/scenarios',
  });
  if (!listed.ok) throw new Error(`список сценариев не получен: ${listed.reason}`);

  const available = scenariosResponseSchema.safeParse(listed.body);
  if (!available.success) throw new Error('шлюз вернул список сценариев не по контракту');

  const selection = selectScenarios(available.data.scenarios, config.names);
  if (!selection.ok) throw new Error(selection.issue);

  const serverOffsetMs = Date.parse(available.data.serverTime) - SystemClock.now();
  const longestSec = Math.max(...selection.scenarios.map((scenario) => scenario.timeoutSec));
  const conflictLimitMs = resultLimitMs(longestSec);
  const totalSec = selection.scenarios.reduce((sum, scenario) => sum + scenario.timeoutSec, 0);
  say(
    `сценарии стенда ${config.baseUrl}: ${selection.scenarios.map((scenario) => scenario.name).join(', ')}, сумма пределов ${totalSec} с`,
  );

  let standBusy = false;
  for (const scenario of selection.scenarios) {
    say('');
    say(
      `${scenario.name}: «${scenario.title}», шагов ${scenario.steps.length}, предел ${scenario.timeoutSec} с`,
    );
    const result = await attempt(gateway, scenario, {
      email: config.email,
      conflictLimitMs,
      waitConflicts: !standBusy,
      serverOffsetMs,
    });
    say(outcomeLine(result.outcome));
    state.outcomes.push(result.outcome);

    const busy: boolean =
      result.state === 'unfinished' || (standBusy && result.state === 'not-started');
    if (busy && !standBusy) {
      say('стенд остался занят прогоном без итога: следующие сценарии не ждут его конца');
    }
    standBusy = busy;
  }

  const summary = formatSummary(state.outcomes);
  say('');
  say(summary);
  if (config.summaryPath !== null) await appendFile(config.summaryPath, `${summary}\n\n`);

  return state.outcomes.every((outcome) => outcome.passed) ? 0 : 1;
};

const state: CiState = { summaryPath: null, outcomes: [] };
try {
  process.exitCode = await main(state);
} catch (error) {
  const reason = errorText(error);
  process.stderr.write(`scenario-ci: ${reason}\n`);
  process.exitCode = 1;
  if (state.summaryPath !== null) {
    await appendFile(state.summaryPath, `${formatSummary(state.outcomes, reason)}\n\n`).catch(
      (appendError: unknown) => {
        process.stderr.write(`scenario-ci: сводка не записана: ${errorText(appendError)}\n`);
      },
    );
  }
}
