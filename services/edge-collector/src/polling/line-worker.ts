import type { ErrorKind, PollCycle, Stand, StandLine, TelemetryRaw } from '@fieldstream/contracts';
import { buildDeviceReadPlan, profileByKey } from '@fieldstream/device-profiles';
import type { PlanMode, ReadPlan } from '@fieldstream/device-profiles';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import {
  CLOSED_BREAKER,
  breakerAllows,
  breakerView,
  recordFailure,
  recordSuccess,
} from '../breaker/breaker.js';
import type { Breaker } from '../breaker/breaker.js';
import type { Logger } from '@fieldstream/nest-common';
import { createLogThrottle } from '@fieldstream/nest-common';
import { reconnectDelay } from '../transport/backoff.js';
import type { BackoffStep } from '../transport/backoff.js';
import { classifyError, needsReconnect } from '../transport/errors.js';
import type { ModbusLink } from '../transport/modbus-link.js';
import { HardTimeoutError, cycleWatchdogMs, withHardTimeout } from '../transport/timeouts.js';
import { pollDevice } from './device-poll.js';
import { buildPollCycle, buildRawFrame, newTraceId } from './frames.js';
import type { DeviceContext } from './frames.js';

/** Итог одного обхода линии. */
export interface CycleReport {
  readonly outcome: 'polled' | 'idle' | 'disconnected' | 'watchdog';
  readonly durationMs: number;
  readonly polled: number;
  readonly failed: number;
  readonly nextDelayMs: number;
}

/** Состояние воркера для внутреннего эндпоинта и отладки. */
export interface LineSnapshot {
  readonly lineCode: string;
  readonly host: string;
  readonly port: number;
  readonly baud: number;
  readonly planMode: PlanMode;
  readonly pollIntervalMs: number;
  readonly running: boolean;
  readonly connected: boolean;
  readonly reconnectAttempt: number;
  readonly lastCycle: {
    readonly at: string;
    readonly outcome: CycleReport['outcome'];
    readonly durationMs: number;
    readonly polled: number;
    readonly failed: number;
  } | null;
  readonly plans: readonly {
    readonly profileKey: string;
    readonly requestCount: number;
    readonly registerCount: number;
  }[];
  readonly devices: readonly {
    readonly deviceCode: string;
    readonly slaveId: number;
    readonly breaker: ReturnType<typeof breakerView>;
    readonly failures: number;
    readonly nextProbeAt: string | null;
  }[];
}

export interface LineWorkerOptions {
  readonly stand: Stand;
  readonly line: StandLine;
  readonly host: string;
  readonly link: ModbusLink;
  readonly clock: Clock;
  readonly random: () => number;
  readonly log: Logger;
  readonly publishRaw: (frame: TelemetryRaw) => void;
  readonly publishCycle: (cycle: PollCycle) => void;
  readonly onPoll?: (errorKind: ErrorKind | null) => void;
  readonly onCycle?: (report: CycleReport, openBreakers: number) => void;
  readonly onReconnect?: () => void;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Воркер одной линии RS-485: единственный, кто ходит в её порт. */
export interface LineWorker {
  readonly lineCode: string;
  readonly runCycle: () => Promise<CycleReport>;
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  readonly isRunning: () => boolean;
  readonly setPlanMode: (mode: PlanMode) => void;
  readonly setPollInterval: (ms: number) => void;
  readonly snapshot: () => LineSnapshot;
}

interface DeviceSlot {
  readonly context: DeviceContext;
  breaker: Breaker;
}

const WATCHDOG_RETRY_MS = 1_000;

/** Пауза, которую прерывает остановка воркера. */
const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Приборы линии в порядке адресов вместе со всем, что едет в их кадры. */
const lineSlots = (stand: Stand, line: StandLine): DeviceSlot[] => {
  const gateway = stand.gateways.find((candidate) => candidate.code === line.gatewayCode);
  if (gateway === undefined) throw new Error(`линия ${line.code}: нет шлюза ${line.gatewayCode}`);

  return stand.devices
    .filter((device) => device.lineCode === line.code)
    .sort((left, right) => left.slaveId - right.slaveId)
    .map((device) => {
      const profile = profileByKey(device.profileKey);
      if (profile === undefined) {
        throw new Error(`прибор ${device.code}: неизвестная модель ${device.profileKey}`);
      }
      return {
        context: {
          siteCode: gateway.siteCode,
          gatewayCode: gateway.code,
          lineCode: line.code,
          device,
          profile,
        },
        breaker: CLOSED_BREAKER,
      };
    });
};

/**
 * Бесконечный последовательный цикл по линии: следующий обход планируется только после
 * завершения предыдущего, поэтому очередь опросов не копится. Каждое ожидание внутри обхода
 * ограничено жёстким таймаутом, а весь обход сверху стережёт сторожевой таймер.
 */
export const createLineWorker = (options: LineWorkerOptions): LineWorker => {
  const { line, link, clock, log } = options;
  const sleep = options.sleep ?? abortableSleep;
  const slots = lineSlots(options.stand, line);
  const throttle = createLogThrottle(clock);
  const plans = new Map<string, ReadPlan>();
  let planMode: PlanMode = 'merged';
  let pollIntervalMs = line.pollIntervalMs;
  let reconnectAttempt = 0;
  let generation = 0;
  let lastCycle: LineSnapshot['lastCycle'] = null;
  let running = false;
  let loop: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let runId = 0;
  let abort = new AbortController();

  const planFor = (context: DeviceContext): ReadPlan => {
    const key = `${context.profile.profileKey}:${String(context.profile.version)}:${planMode}`;
    const cached = plans.get(key);
    if (cached !== undefined) return cached;
    const plan = buildDeviceReadPlan(context.profile, { mode: planMode });
    plans.set(key, plan);
    return plan;
  };

  const breakerFacts = (breaker: Breaker, now: number): PollCycle['breaker'] & {} => ({
    state: breakerView(breaker, now),
    nextProbeAt: breaker.nextProbeAt === null ? null : toIsoTimestamp(breaker.nextProbeAt),
  });

  const logFailure = (slot: DeviceSlot, errorKind: ErrorKind, error: unknown): void => {
    const decision = throttle(`${slot.context.device.code}:${errorKind}`);
    if (!decision.pass) return;
    log.warn(
      {
        line: line.code,
        device: slot.context.device.code,
        errorKind,
        suppressed: decision.suppressed,
        err: error,
      },
      'прибор не ответил',
    );
  };

  /** Отказ, при котором до прибора не дошёл ни один запрос: порт шлюза недоступен. */
  const reportUnreachable = (
    due: readonly DeviceSlot[],
    error: unknown,
    step: BackoffStep,
    traceId: string,
  ): void => {
    const now = clock.now();
    const errorKind = classifyError(error);

    for (const slot of due) {
      slot.breaker = recordFailure(slot.breaker, now);
      options.onPoll?.(errorKind);
      options.publishCycle(
        buildPollCycle(
          slot.context,
          {
            ok: false,
            errorKind,
            durationMs: 0,
            requestCount: 0,
            planMode,
            backoff: step,
            breaker: {
              state: breakerView(slot.breaker, now),
              nextProbeAt: slot.breaker.nextProbeAt,
            },
          },
          now,
          traceId,
        ),
      );
    }
  };

  /** Открывает порт, если он закрыт. При неудаче возвращает выбранную задержку переподключения. */
  const ensureLink = async (): Promise<{ step: BackoffStep; error: unknown } | null> => {
    if (link.isOpen()) return null;

    try {
      options.onReconnect?.();
      await link.connect();
      if (reconnectAttempt > 0) log.info({ line: line.code }, 'порт линии снова доступен');
      reconnectAttempt = 0;
      return null;
    } catch (error) {
      const step = reconnectDelay(reconnectAttempt, options.random);
      reconnectAttempt += 1;
      if (throttle(`connect:${classifyError(error)}`).pass) {
        log.warn(
          { line: line.code, host: options.host, port: line.port, backoff: step, err: error },
          'порт линии недоступен',
        );
      }
      return { step, error };
    }
  };

  const runCycle = async (): Promise<CycleReport> => {
    const cycleGeneration = generation;
    const startedAt = clock.now();
    const traceId = newTraceId();
    const due = slots.filter((slot) => breakerAllows(slot.breaker, startedAt));
    let polled = 0;
    let failed = 0;

    if (due.length === 0) {
      return { outcome: 'idle', durationMs: 0, polled, failed, nextDelayMs: pollIntervalMs };
    }

    for (const [index, slot] of due.entries()) {
      if (cycleGeneration !== generation) break;

      const unreachable = await ensureLink();
      if (unreachable !== null) {
        reportUnreachable(due.slice(index), unreachable.error, unreachable.step, traceId);
        return {
          outcome: 'disconnected',
          durationMs: clock.now() - startedAt,
          polled,
          failed: failed + due.length - index,
          nextDelayMs: unreachable.step.chosenMs,
        };
      }

      const poll = await pollDevice(
        link.read,
        slot.context.device.slaveId,
        planFor(slot.context),
        clock,
      );
      if (cycleGeneration !== generation) break;

      const now = clock.now();
      slot.breaker = poll.ok ? recordSuccess() : recordFailure(slot.breaker, now);
      polled += 1;
      options.onPoll?.(poll.errorKind);

      if (poll.ok) {
        options.publishRaw(buildRawFrame(slot.context, poll.blocks, now, poll.durationMs, traceId));
      } else if (poll.errorKind !== null) {
        failed += 1;
        logFailure(slot, poll.errorKind, poll.error);
        if (needsReconnect(poll.errorKind)) link.destroy();
      }

      options.publishCycle(
        buildPollCycle(
          slot.context,
          {
            ok: poll.ok,
            errorKind: poll.errorKind,
            durationMs: poll.durationMs,
            requestCount: poll.requestCount,
            planMode,
            breaker: {
              state: breakerView(slot.breaker, now),
              nextProbeAt: slot.breaker.nextProbeAt,
            },
          },
          now,
          traceId,
        ),
      );
    }

    const durationMs = clock.now() - startedAt;
    return {
      outcome: 'polled',
      durationMs,
      polled,
      failed,
      nextDelayMs: Math.max(0, pollIntervalMs - durationMs),
    };
  };

  /** Обход под сторожевым таймером: зависший обход бросается, соединение рвётся принудительно. */
  const guardedCycle = async (): Promise<CycleReport> => {
    try {
      return await withHardTimeout(runCycle(), cycleWatchdogMs(pollIntervalMs));
    } catch (error) {
      generation += 1;
      link.destroy();
      if (error instanceof HardTimeoutError) {
        log.error({ line: line.code }, 'сторож цикла: обход завис, соединение разорвано');
      } else {
        log.error({ line: line.code, err: error }, 'сбой обхода линии');
      }
      return {
        outcome: 'watchdog',
        durationMs: 0,
        polled: 0,
        failed: 0,
        nextDelayMs: WATCHDOG_RETRY_MS,
      };
    }
  };

  /** Работает ли воркер прямо сейчас: остановка может прийти во время любого ожидания. */
  const isRunning = (): boolean => running;

  /** Цикл живёт до остановки или до следующего запуска: свой номер он проверяет сам. */
  const runLoop = async (myRun: number): Promise<void> => {
    while (isRunning() && runId === myRun) {
      const report = await guardedCycle();
      lastCycle = {
        at: toIsoTimestamp(clock.now()),
        outcome: report.outcome,
        durationMs: report.durationMs,
        polled: report.polled,
        failed: report.failed,
      };
      options.onCycle?.(report, slots.filter((slot) => slot.breaker.open).length);
      if (isRunning() && runId === myRun) await sleep(report.nextDelayMs, abort.signal);
    }
  };

  return {
    lineCode: line.code,
    runCycle,
    /**
     * Запуск дожидается незавершённой остановки. Иначе включение сразу после выключения
     * попадает в гонку: остановка доводит своё дело до конца и закрывает порт уже нового цикла.
     */
    start: () => {
      if (running) return;
      running = true;
      runId += 1;
      const myRun = runId;
      abort = new AbortController();
      const previous = stopping;
      loop = (async () => {
        if (previous !== null) await previous;
        await runLoop(myRun);
      })();
    },
    /** Остановка не закрывает порт, если её успели обогнать новым запуском. */
    stop: async () => {
      if (!isRunning() && stopping !== null) return stopping;
      running = false;
      abort.abort();
      const current = loop;
      stopping = (async () => {
        await current;
        if (!isRunning()) {
          loop = null;
          link.destroy();
        }
        stopping = null;
      })();

      return stopping;
    },
    isRunning,
    setPlanMode: (mode) => {
      planMode = mode;
    },
    setPollInterval: (ms) => {
      pollIntervalMs = ms;
    },
    snapshot: () => {
      const now = clock.now();
      return {
        lineCode: line.code,
        host: options.host,
        port: line.port,
        baud: line.baud,
        planMode,
        pollIntervalMs,
        running,
        connected: link.isOpen(),
        reconnectAttempt,
        lastCycle,
        plans: [
          ...new Map(slots.map((slot) => [slot.context.profile.profileKey, slot])).values(),
        ].map((slot) => {
          const plan = planFor(slot.context);
          return {
            profileKey: plan.profileKey,
            requestCount: plan.requestCount,
            registerCount: plan.registerCount,
          };
        }),
        devices: slots.map((slot) => ({
          deviceCode: slot.context.device.code,
          slaveId: slot.context.device.slaveId,
          ...breakerFacts(slot.breaker, now),
          breaker: breakerView(slot.breaker, now),
          failures: slot.breaker.failures,
        })),
      };
    },
  };
};
