import { resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type pg from 'pg';
import type {
  ScenarioRun,
  ScenarioRunSource,
  ScenarioRunStep,
  ScenariosResponse,
} from '@fieldstream/contracts';
import {
  countAlarmsRaisedSince,
  createScenarioRun,
  failStaleScenarioRuns,
  finishScenarioRun,
  loadActiveAlarmFacts,
  loadActiveScenarioRun,
  loadDlqCounts,
  loadLastScenarioRuns,
  loadScenarioRun,
  loadStandDeviceFacts,
  touchScenarioRun,
  updateScenarioRunProgress,
} from '@fieldstream/db';
import type { ScenarioRunOutcome, ScenarioRunOwner } from '@fieldstream/db';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import type { Logger } from '@fieldstream/nest-common';
import {
  SCENARIOS_DIR,
  ScenarioLoadError,
  describeStep,
  loadScenarios,
  runScenario,
} from '@fieldstream/scenarios';
import type { Scenario, ScenarioPorts, ScenarioProgress, StandFacts } from '@fieldstream/scenarios';
import { withClient } from '../common/with-client.js';
import type { Env } from '../config/env.js';
import { LineStatusService } from '../lab/line-status.service.js';
import { SimClientService } from '../lab/sim-client.service.js';
import { CLOCK, ENV, INSTANCE_ID, LOGGER, POOL } from '../tokens.js';
import { createProgressWriter } from './progress-writer.js';
import {
  busyMessage,
  closeSteps,
  faultTargetsOf,
  lineFactsOf,
  planSteps,
} from './scenario-calc.js';

const PROGRESS_WRITE_MS = 1_000;
const HEARTBEAT_MS = 5_000;
const STALE_HEARTBEAT_MS = 30_000;
const SWEEP_MS = 10_000;
const SHUTDOWN_WAIT_MS = 15_000;
const FINISH_ATTEMPTS = 3;
const FINISH_RETRY_MS = 1_000;

const STALE_ERROR = 'шлюз перезапустился посреди прогона';
const ABANDONED_ERROR = `шлюз, исполнявший прогон, не отмечался дольше ${STALE_HEARTBEAT_MS / 1000} с`;
const STOPPED_ERROR = 'шлюз остановлен посреди прогона';
const STOPPING = 'шлюз останавливается';
const STOPPING_REPLY = 'шлюз останавливается, повторите запуск позже';
const TAKEN_OVER = 'прогон уже завершён без этого шлюза';

/** Итог записи результата: записан, прогон уже был завершён, запись не удалась. */
type FinishWrite = 'written' | 'closed' | 'failed';

/** Прогон, который исполняет этот процесс. */
interface ActiveRun {
  readonly id: string;
  readonly controller: AbortController;
  latest: ScenarioProgress | null;
  haltReason: string | null;
  settled: boolean;
  done: Promise<void>;
}

/** Почему исполнение прогона прервано. */
const haltError = (run: ActiveRun): Error => new Error(run.haltReason ?? STOPPING);

/** Ожидание, которое обрывается прерыванием прогона. */
const sleepUnlessHalted = async (ms: number, run: ActiveRun): Promise<void> => {
  try {
    await delay(ms, undefined, { signal: run.controller.signal });
  } catch {
    throw haltError(run);
  }
};

/**
 * Сценарии стенда: каталог YAML, запуск прогона в фоне и его ход в базе. Прогон на стенде один,
 * это держит уникальный индекс базы. Исполнитель отмечает пульс, и прогон с протухшим пульсом
 * завершает с ошибкой любой экземпляр шлюза; потерявший прогон исполнитель прерывает его и
 * снимает поломки. При остановке шлюза новые запуски не принимаются, идущий прогон прерывается:
 * поломки снимаются, итог пишется провалом с понятной причиной.
 */
@Injectable()
export class ScenariosService
  implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown
{
  private readonly dir: URL;
  private readonly active = new Map<string, ActiveRun>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  public constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(INSTANCE_ID) private readonly instanceId: string,
    private readonly lineStatus: LineStatusService,
    private readonly sim: SimClientService,
  ) {
    this.dir =
      env.SCENARIOS_DIR === undefined
        ? SCENARIOS_DIR
        : pathToFileURL(`${resolve(env.SCENARIOS_DIR)}${sep}`);
  }

  /** Прогоны прежнего процесса и с протухшим пульсом завершаются, дальше это проверяется периодически. */
  public async onApplicationBootstrap(): Promise<void> {
    await this.sweep(STALE_ERROR, this.instanceId);
    if (this.stopping) return;

    this.sweepTimer = setInterval(() => {
      void this.sweep(ABANDONED_ERROR, null);
    }, SWEEP_MS);
    this.sweepTimer.unref();
  }

  /** Остановка начинается раньше закрытия HTTP: запуски с этого момента отклоняются. */
  public onModuleDestroy(): void {
    this.stopping = true;
    if (this.sweepTimer === null) return;

    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  public async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([...this.active.values()].map((run) => this.stop(run)));
  }

  /** Сценарии с последними прогонами и прогон, который идёт сейчас. */
  public async list(): Promise<ScenariosResponse> {
    const scenarios = await this.catalog();
    const { lastRuns, activeRun } = await withClient(this.pool, async (client) => ({
      lastRuns: await loadLastScenarioRuns(client),
      activeRun: await loadActiveScenarioRun(client),
    }));
    const lastByName = new Map(lastRuns.map((run) => [run.scenario, run]));

    return {
      serverTime: toIsoTimestamp(this.clock.now()),
      scenarios: scenarios.map((scenario) => ({
        name: scenario.name,
        title: scenario.title,
        description: scenario.description,
        timeoutSec: scenario.timeoutSec,
        steps: scenario.steps.map(describeStep),
        lastRun: lastByName.get(scenario.name) ?? null,
      })),
      activeRun,
    };
  }

  public load(id: string): Promise<ScenarioRun | null> {
    return withClient(this.pool, (client) => loadScenarioRun(client, id));
  }

  /**
   * Ставит прогон и запускает его в фоне. Неизвестный сценарий это 404, занятый стенд 409,
   * остановка шлюза 503. Брошенный прогон перед постановкой завершается и стенд не держит.
   */
  public async start(
    name: string,
    source: ScenarioRunSource,
    requestedBy: string,
  ): Promise<ScenarioRun> {
    if (this.isStopping()) throw new ServiceUnavailableException(STOPPING_REPLY);

    const scenario = (await this.catalog()).find((item) => item.name === name);
    if (scenario === undefined) throw new NotFoundException(`сценария «${name}» нет`);

    await this.sweep(ABANDONED_ERROR, null);
    const created = await withClient(this.pool, (client) =>
      createScenarioRun(client, {
        scenario: scenario.name,
        title: scenario.title,
        source,
        requestedBy,
        steps: planSteps(scenario),
        owner: this.owner(),
      }),
    );
    if (!created.created) throw new ConflictException(busyMessage(created.active));

    if (this.isStopping()) {
      const at = toIsoTimestamp(this.clock.now());
      await this.finish(created.run.id, {
        status: 'failed',
        steps: closeSteps(created.run.steps, at, STOPPING),
        error: `${STOPPED_ERROR}: запуск пришёл во время остановки`,
        startedAt: null,
        finishedAt: at,
      });
      throw new ServiceUnavailableException(STOPPING_REPLY);
    }

    this.log.info(
      { user: requestedBy, runId: created.run.id, scenario: scenario.name, source },
      'прогон сценария стенда запущен',
    );
    this.launch(created.run.id, scenario);

    return created.run;
  }

  /** Идёт ли остановка шлюза: флаг меняется между ожиданиями запуска. */
  private isStopping(): boolean {
    return this.stopping;
  }

  /** Каталог сценариев. Неверно описанный сценарий это ошибка стенда, а не запроса. */
  private async catalog(): Promise<Scenario[]> {
    try {
      return await loadScenarios(this.dir);
    } catch (error) {
      if (!(error instanceof ScenarioLoadError)) throw error;

      this.log.error({ issues: error.issues }, 'сценарии стенда описаны неверно');
      throw new InternalServerErrorException(
        'сценарии стенда описаны неверно, подробности в журнале',
      );
    }
  }

  /** Исполнитель прогона с пульсом на текущий момент. */
  private owner(): ScenarioRunOwner {
    return { instanceId: this.instanceId, heartbeatAt: toIsoTimestamp(this.clock.now()) };
  }

  /** Завершает брошенные прогоны: без пульса дольше предела или прежнего процесса instanceId. */
  private async sweep(error: string, instanceId: string | null): Promise<void> {
    const nowMs = this.clock.now();
    try {
      const failed = await withClient(this.pool, (client) =>
        failStaleScenarioRuns(
          client,
          { staleBefore: toIsoTimestamp(nowMs - STALE_HEARTBEAT_MS), instanceId },
          error,
          toIsoTimestamp(nowMs),
        ),
      );
      if (failed > 0) {
        this.log.warn({ failed, error }, 'брошенные прогоны сценариев завершены с ошибкой');
      }
    } catch (err) {
      this.log.warn({ err }, 'брошенные прогоны сценариев проверить не удалось');
    }
  }

  /** Прерывает исполнение. Уже доигравший прогон не прерывается, первая причина сохраняется. */
  private halt(run: ActiveRun, reason: string): void {
    if (run.settled || run.haltReason !== null) return;

    run.haltReason = reason;
    run.controller.abort();
    if (reason === TAKEN_OVER) {
      this.log.warn(
        { runId: run.id },
        'прогон сценария завершён без этого шлюза, исполнение прервано',
      );
    }
  }

  private launch(id: string, scenario: Scenario): void {
    const run: ActiveRun = {
      id,
      controller: new AbortController(),
      latest: null,
      haltReason: null,
      settled: false,
      done: Promise.resolve(),
    };
    this.active.set(id, run);
    run.done = this.execute(run, scenario)
      .catch((error: unknown) => {
        this.log.error({ err: error, runId: id }, 'прогон сценария стенда упал');
      })
      .finally(() => {
        this.active.delete(id);
      });
  }

  /** Пульс исполнителя: прогон, который уже не его, прерывается. */
  private async beat(run: ActiveRun): Promise<void> {
    try {
      const owned = await withClient(this.pool, (client) =>
        touchScenarioRun(client, run.id, this.owner()),
      );
      if (!owned) this.halt(run, TAKEN_OVER);
    } catch (error) {
      this.log.warn({ err: error, runId: run.id }, 'пульс прогона сценария не записан');
    }
  }

  /** Исполняет прогон: ход в базу не чаще раза в секунду, пульс, итог отдельной обязательной записью. */
  private async execute(run: ActiveRun, scenario: Scenario): Promise<void> {
    const writer = createProgressWriter<ScenarioProgress>({
      intervalMs: PROGRESS_WRITE_MS,
      clock: this.clock,
      write: async (progress) => {
        const owned = await withClient(this.pool, (client) =>
          updateScenarioRunProgress(client, run.id, this.owner(), {
            steps: progress.steps,
            startedAt: progress.startedAt,
          }),
        );
        if (!owned) this.halt(run, TAKEN_OVER);
      },
      onError: (error) => {
        this.log.warn({ err: error, runId: run.id }, 'ход прогона сценария не записан');
      },
    });
    const heartbeat = setInterval(() => {
      void this.beat(run);
    }, HEARTBEAT_MS);
    heartbeat.unref();

    let result: Awaited<ReturnType<typeof runScenario>>;
    try {
      result = await runScenario(scenario, {
        ports: this.portsFor(run),
        clock: this.clock,
        sleep: (ms) => sleepUnlessHalted(ms, run),
        pollMs: this.env.SCENARIO_POLL_MS,
        onProgress: (progress) => {
          run.latest = progress;
          writer.push(progress);
        },
      });
    } finally {
      run.settled = true;
      clearInterval(heartbeat);
    }
    await writer.close();

    const stopped = run.haltReason === STOPPING && result.status === 'failed';
    const error = stopped ? [STOPPED_ERROR, result.error].filter(Boolean).join('; ') : result.error;
    const written = await this.finish(run.id, {
      status: result.status,
      steps: result.steps,
      error,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
    });

    const fields = {
      runId: run.id,
      scenario: scenario.name,
      status: result.status,
      seconds: Math.round((Date.parse(result.finishedAt) - Date.parse(result.startedAt)) / 1000),
    };
    if (written === 'closed') {
      this.log.warn(
        { ...fields, error },
        'итог прогона не записан: прогон уже завершён без этого шлюза',
      );
    } else if (result.status === 'passed') {
      this.log.info(fields, 'прогон сценария стенда прошёл');
    } else {
      this.log.warn({ ...fields, error }, 'прогон сценария стенда не прошёл');
    }
  }

  /** Порты прогона. После прерывания новых поломок и опросов нет, снимать поломки можно. */
  private portsFor(run: ActiveRun): ScenarioPorts {
    const ensureRunning = (): void => {
      if (run.controller.signal.aborted) throw haltError(run);
    };

    return {
      inject: async (request) => {
        ensureRunning();
        return this.sim.injectFault(request);
      },
      clear: (filter) => this.sim.clearFaults(filter),
      simScenario: async (name) => {
        ensureRunning();
        const reply = await this.sim.runScenario(name);
        const rejected = reply.results.filter((result) => result.outcome === 'rejected');
        if (rejected.length > 0) {
          this.log.warn({ scenario: name, rejected }, 'стенд отверг часть поломок сценария');
        }
        return faultTargetsOf(reply.results);
      },
      facts: async (startedAt) => {
        ensureRunning();
        return this.facts(startedAt);
      },
    };
  }

  /** Факты стенда: размыкатели и линии из свежих снимков сборщика, приборы, алармы и очередь из базы. */
  private async facts(startedAt: string): Promise<StandFacts> {
    const lines = lineFactsOf(this.lineStatus.lines(), startedAt, this.clock.now());

    return withClient(this.pool, async (client) => {
      const devices = await loadStandDeviceFacts(client);
      const activeAlarms = await loadActiveAlarmFacts(client);
      const alarmsRaisedSinceStart = await countAlarmsRaisedSince(client, startedAt);
      const dlq = await loadDlqCounts(client);

      return {
        ...lines,
        devices: Object.fromEntries(
          devices.map((device) => [
            device.deviceCode,
            { status: device.status, reason: device.reason, mode: device.mode },
          ]),
        ),
        activeAlarms,
        alarmsRaisedSinceStart,
        dlqTotal: dlq.total,
      };
    });
  }

  /** Итог прогона с повтором: не записанный итог держал бы стенд занятым, пока не протухнет пульс. */
  private async finish(id: string, outcome: ScenarioRunOutcome): Promise<FinishWrite> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const written = await withClient(this.pool, (client) =>
          finishScenarioRun(client, id, outcome),
        );
        return written ? 'written' : 'closed';
      } catch (error) {
        if (attempt >= FINISH_ATTEMPTS) {
          this.log.error(
            { err: error, runId: id },
            'итог прогона сценария не записан: прогон завершится с ошибкой по пульсу',
          );
          return 'failed';
        }
        await delay(FINISH_RETRY_MS);
      }
    }
  }

  /**
   * Прерывает прогон при остановке шлюза и ждёт уборки с пределом. Не уложилась уборка, итог
   * пишется сразу: поломки со сроком снимет сам стенд.
   */
  private async stop(run: ActiveRun): Promise<void> {
    this.halt(run, STOPPING);

    const settled = await Promise.race([
      run.done.then(() => true),
      delay(SHUTDOWN_WAIT_MS, false, { ref: false }),
    ]);
    if (settled) return;

    const at = toIsoTimestamp(this.clock.now());
    const steps: ScenarioRunStep[] = closeSteps(run.latest?.steps ?? [], at, STOPPING);
    await this.finish(run.id, {
      status: 'failed',
      steps,
      error: `${STOPPED_ERROR}: уборка не уложилась в ${SHUTDOWN_WAIT_MS / 1000} с, внесённые поломки снимутся сами по сроку`,
      startedAt: run.latest?.startedAt ?? null,
      finishedAt: at,
    });
  }
}
