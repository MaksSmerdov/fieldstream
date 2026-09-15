import { Inject, Injectable } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import type { Admin, Consumer, EachBatchPayload, KafkaMessage } from 'kafkajs';
import type pg from 'pg';
import {
  REPLAY_GROUP_PREFIX,
  REPLAY_KEPT_RUNS,
  TOPICS,
  replayGroupIdOf,
} from '@fieldstream/contracts';
import type { ReplayProgress, ReplayRun } from '@fieldstream/contracts';
import {
  claimReplayRun,
  failReplayRun,
  failStaleReplayRuns,
  finishReplayRun,
  insertReplayEpisodes,
  loadActiveReplayRun,
  pruneReplayRuns,
  updateReplayProgress,
  withTransaction,
} from '@fieldstream/db';
import type { ClaimedReplayRun, ReplayRunOwner } from '@fieldstream/db';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import { CONSUMER_CONFIG, createConsumer, decodeMessage, readDlqHistory } from '@fieldstream/kafka';
import { createLogThrottle } from '@fieldstream/nest-common';
import type { Logger } from '@fieldstream/nest-common';
import type { Env } from '../config/env.js';
import type { ProcessorMetrics } from '../metrics/metrics.js';
import { ProducerService } from '../publish/producer.service.js';
import { DeviceRefsService } from '../topology/device-refs.service.js';
import { CLOCK, ENV, INSTANCE_ID, LOGGER, METRICS, POOL } from '../tokens.js';
import { createReplayCore, parseReplayRules } from './replay-core.js';
import type { ReplayCore } from './replay-core.js';
import { createPartitionTracker, planPartitions } from './replay-offsets.js';
import type { OffsetsByTime, PartitionTracker } from './replay-offsets.js';

/** Текст ошибки у прогона, чей исполнитель перестал подавать пульс. */
export const STALE_REPLAY_ERROR =
  'процессор, выполнявший перепрогон, перестал отвечать: прогон не завершён, поставьте новый';

/** Текст ошибки у прогона, прерванного остановкой процессора. */
export const SHUTDOWN_REPLAY_ERROR = 'процессор остановлен посреди перепрогона: поставьте новый';

/**
 * Запас за концом окна при поиске конечных смещений: сборщик может отправить кадры окна из буфера
 * уже после его конца, а время сообщения это момент отправки. Лишние кадры отсекает ядро.
 */
export const REPLAY_END_SLACK_MS = 5 * 60_000;

const RAW = TOPICS.telemetryRaw;
const TAKEN_STOP = 'перепрогон отобран';
const GROUP_ID_NOT_FOUND = 69;
const DELETE_GROUP_DELAYS_MS = [500, 1_000, 2_000, 4_000] as const;

/** Чем кончилось чтение окна: всё прочитано или прогон надо завершить с ошибкой. */
type Stop = { readonly kind: 'done' } | { readonly kind: 'failed'; readonly error: string };

/** Сигнал остановки чтения: побеждает первый, ожидание пульса просыпается сразу. */
interface StopLatch {
  readonly value: () => Stop | null;
  readonly done: () => void;
  readonly fail: (error: string) => void;
  readonly wait: (ms: number) => Promise<void>;
}

/** Выполняемый прогон: строка, ядро расчёта, ход по партициям и сигнал остановки. */
interface Execution {
  readonly run: ReplayRun;
  readonly core: ReplayCore;
  readonly tracker: PartitionTracker;
  readonly latch: StopLatch;
}

/** Идущий прогон: строка, сигнал остановки и запись провала, если она уже начата. */
interface ActiveRun {
  readonly run: ReplayRun;
  readonly latch: StopLatch;
  failure: Promise<void> | null;
}

/** Прогон отобран: итог записывает не этот экземпляр. */
class RunTakenError extends Error {
  public constructor() {
    super(TAKEN_STOP);
    this.name = 'RunTakenError';
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Длительность предела словами: ровные минуты минутами, остальное секундами. */
const durationText = (ms: number): string =>
  ms % 60_000 === 0 ? `${String(ms / 60_000)} мин` : `${String(Math.ceil(ms / 1_000))} с`;

/** Сигнал остановки с ожиданием, которое просыпается раньше срока. */
const createStopLatch = (): StopLatch => {
  let stop: Stop | null = null;
  const sleepers = new Set<() => void>();

  const settle = (next: Stop): void => {
    if (stop !== null) return;
    stop = next;
    for (const wake of sleepers) wake();
    sleepers.clear();
  };

  return {
    value: () => stop,
    done: () => {
      settle({ kind: 'done' });
    },
    fail: (error) => {
      settle({ kind: 'failed', error });
    },
    wait: (ms) =>
      new Promise((resolve) => {
        if (stop !== null) {
          resolve();
          return;
        }
        const wake = (): void => {
          clearTimeout(timer);
          sleepers.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, ms);
        sleepers.add(wake);
      }),
  };
};

/** Коды ошибок удаления групп из исключения kafkajs. */
const deleteGroupCodes = (error: unknown): number[] => {
  if (typeof error !== 'object' || error === null || !('groups' in error)) return [];
  const groups: unknown = error.groups;
  if (!Array.isArray(groups)) return [];
  const items: readonly unknown[] = groups;
  return items.flatMap((item) =>
    typeof item === 'object' && item !== null && 'errorCode' in item
      ? typeof item.errorCode === 'number'
        ? [item.errorCode]
        : []
      : [],
  );
};

const progressOf = (execution: Execution): ReplayProgress => {
  const counts = execution.core.counts();
  return {
    offsetsTotal: execution.tracker.offsetsTotal,
    offsetsDone: execution.tracker.offsetsDone(),
    framesMatched: counts.framesMatched,
    framesRejected: counts.framesRejected,
  };
};

/**
 * Перепрогон уставок. Шлюз кладёт прогон в базу, а исполняет его процессор: забирает строку,
 * находит смещения окна по времени и читает сырой топик временной группой fs-replay-<id>
 * без подтверждения смещений. Каждый кадр проходит ядро с уставками «было» и «стало». Ход и пульс
 * пишутся раз в REPLAY_HEARTBEAT_MS: если строка уже не наша, работа останавливается без итога.
 * Итог пишется одной транзакцией, первым шагом finishReplayRun. После прогона потребитель
 * отключается, а временная группа удаляется. Боевая группа процессора не трогается никогда.
 */
@Injectable()
export class ReplayRunnerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly throttle: (key: string) => { pass: boolean };
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<boolean> | null = null;
  private active: ActiveRun | null = null;
  private stopped = false;

  public constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(METRICS) private readonly metrics: ProcessorMetrics,
    @Inject(INSTANCE_ID) private readonly instanceId: string,
    private readonly producer: ProducerService,
    private readonly refs: DeviceRefsService,
  ) {
    this.throttle = createLogThrottle(clock);
  }

  public onApplicationBootstrap(): void {
    if (this.env.REPLAY === 'off') {
      this.log.info({}, 'перепрогон выключен: прогоны остаются в очереди');
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.env.REPLAY_POLL_MS);
    this.timer.unref();
  }

  /**
   * Остановка до отключения продюсера: идущий прогон прерывается и сразу завершается с ошибкой,
   * не дожидаясь брокера, который может не ответить до конца срока остановки контейнера.
   */
  public async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    const active = this.active;
    if (active !== null && active.latch.value() === null) {
      active.latch.fail(SHUTDOWN_REPLAY_ERROR);
      await this.failOnce(active, new Error(SHUTDOWN_REPLAY_ERROR));
    }
    await this.current;
  }

  /** Один проход: завершает брошенные прогоны, забирает ждущий и выполняет его. Истина, если забран. */
  public tick(): Promise<boolean> {
    if (this.env.REPLAY === 'off' || this.stopped || this.current !== null) {
      return Promise.resolve(false);
    }
    if (!this.producer.isConnected() || !this.refs.isLoaded()) return Promise.resolve(false);

    const run = this.runOnce().finally(() => {
      this.current = null;
    });
    this.current = run;
    return run;
  }

  private async runOnce(): Promise<boolean> {
    if (!(await this.recoverStale())) return false;

    let claimed: ClaimedReplayRun | null;
    try {
      claimed = await withTransaction(this.pool, (client) => claimReplayRun(client, this.owner()));
    } catch (error) {
      if (this.throttle('replay-claim').pass) {
        this.log.warn({ err: error }, 'перепрогон не забран, повтор на следующем такте');
      }
      return false;
    }
    if (claimed === null) return false;

    await this.perform(claimed);
    return true;
  }

  /** Прогоны с протухшим пульсом завершаются с ошибкой: их исполнитель упал или завис. */
  private async recoverStale(): Promise<boolean> {
    try {
      const now = this.clock.now();
      const failed = await withTransaction(this.pool, (client) =>
        failStaleReplayRuns(
          client,
          { staleBefore: toIsoTimestamp(now - this.env.REPLAY_STALE_MS) },
          STALE_REPLAY_ERROR,
          toIsoTimestamp(now),
        ),
      );
      if (failed > 0) {
        this.log.warn({ failed }, 'брошенные перепрогоны завершены с ошибкой');
        await this.dropOrphanGroups();
      }
      return true;
    } catch (error) {
      if (this.throttle('replay-recover').pass) {
        this.log.warn(
          { err: error },
          'брошенные перепрогоны не проверены, повтор на следующем такте',
        );
      }
      return false;
    }
  }

  /**
   * Временные группы брошенных прогонов: их исполнитель упал и группу не удалил. Удаляются все группы
   * перепрогона, кроме группы активного прогона. Группу с участником брокер не удалит, поэтому
   * гонка с чужим живым прогоном безопасна. Боевая группа под префикс не попадает.
   */
  private async dropOrphanGroups(): Promise<void> {
    const admin = this.producer.kafka.admin();
    try {
      await admin.connect();
      const active = await withTransaction(this.pool, (client) => loadActiveReplayRun(client));
      const keep = active === null ? null : replayGroupIdOf(active.id);
      const orphans = (await admin.listGroups()).groups
        .map((group) => group.groupId)
        .filter((groupId) => groupId.startsWith(REPLAY_GROUP_PREFIX) && groupId !== keep);
      if (orphans.length === 0) return;
      await admin.deleteGroups(orphans);
      this.log.info({ groups: orphans }, 'временные группы брошенных перепрогонов удалены');
    } catch (error) {
      if (this.throttle('replay-orphans').pass) {
        this.log.warn(
          { err: error },
          'временные группы брошенных перепрогонов не удалены: пустые группы брокер уберёт сам',
        );
      }
    } finally {
      await admin.disconnect().catch(() => undefined);
    }
  }

  /** Выполнение забранного прогона от смещений до итога. Любой сбой завершает прогон с ошибкой. */
  private async perform(claimed: ClaimedReplayRun): Promise<void> {
    const { run } = claimed;
    const latch = createStopLatch();
    const active: ActiveRun = { run, latch, failure: null };
    this.active = active;
    if (this.stopped) latch.fail(SHUTDOWN_REPLAY_ERROR);
    const startedAt = this.clock.now();
    const kafka = this.producer.kafka;
    let admin: Admin | null = null;
    let consumer: Consumer | null = null;

    this.log.info(
      { replayRunId: run.id, from: run.from, to: run.to, devices: run.deviceCodes.length },
      'перепрогон забран',
    );

    try {
      const core = createReplayCore({
        from: run.from,
        to: run.to,
        deviceCodes: run.deviceCodes,
        refs: this.refs.current(),
        rules: parseReplayRules(claimed.rules),
      });
      this.ensureRunning(latch);
      admin = kafka.admin();
      await admin.connect();
      const tracker = createPartitionTracker(planPartitions(await this.offsetsOf(admin, run)));
      const execution: Execution = { run, core, tracker, latch };
      this.ensureRunning(latch);

      if (tracker.offsetsTotal === 0) {
        latch.done();
        await this.finish(execution);
        return;
      }

      if (!(await this.report(execution, replayGroupIdOf(run.id), true))) {
        this.ensureRunning(latch);
        this.taken(run);
        return;
      }
      this.ensureRunning(latch);

      consumer = createConsumer(kafka, replayGroupIdOf(run.id), {
        retry: { ...CONSUMER_CONFIG.retry, restartOnFailure: () => Promise.resolve(false) },
      });
      const watching = this.watch(execution, startedAt);
      try {
        await this.consume(consumer, execution);
      } catch (error) {
        latch.fail(messageOf(error));
      }
      if ((await watching) === 'taken') {
        this.taken(run);
        return;
      }
      this.ensureRunning(latch);
      await this.finish(execution);
    } catch (error) {
      await this.failOnce(active, error);
    } finally {
      this.active = null;
      await this.release(consumer, admin, run.id);
    }
  }

  private ensureRunning(latch: StopLatch): void {
    const stop = latch.value();
    if (stop?.kind === 'failed') throw new Error(stop.error);
  }

  /**
   * Смещения по времени начала и конца окна с запасом REPLAY_END_SLACK_MS, затем границы лога.
   * Кадры окна, задержанные в буфере сборщика дольше запаса, в прогон не попадут.
   */
  private async offsetsOf(admin: Admin, run: ReplayRun): Promise<OffsetsByTime> {
    const starts = await admin.fetchTopicOffsetsByTimestamp(RAW.name, Date.parse(run.from));
    const ends = await admin.fetchTopicOffsetsByTimestamp(
      RAW.name,
      Date.parse(run.to) + REPLAY_END_SLACK_MS,
    );
    const bounds = await admin.fetchTopicOffsets(RAW.name);
    return { starts, ends, bounds };
  }

  /**
   * На вступлении временной группы каждая недочитанная партиция переводится на свою позицию окна,
   * дочитанная ставится на паузу. Смещения не подтверждаются. Подписка с начала лога: если позиция
   * ушла по сроку хранения, брокер сбросит чтение на уцелевшее начало, а не на конец. Любой сбой
   * потребителя проваливает прогон. Перезапуск, который kafkajs ставит таймером сразу после события
   * сбоя, отменяется остановкой в микрозадаче: иначе потребитель вступил бы в группу после
   * освобождения и остался бы в ней.
   */
  private async consume(consumer: Consumer, execution: Execution): Promise<void> {
    const { tracker, latch } = execution;

    consumer.on(consumer.events.GROUP_JOIN, (event) => {
      const assigned = event.payload.memberAssignment[RAW.name] ?? [];
      const finished = tracker.finished().filter((partition) => assigned.includes(partition));
      if (finished.length > 0) consumer.pause([{ topic: RAW.name, partitions: finished }]);
      for (const position of tracker.pending()) {
        if (!assigned.includes(position.partition)) continue;
        consumer.seek({ topic: RAW.name, partition: position.partition, offset: position.offset });
      }
    });
    consumer.on(consumer.events.CRASH, (event) => {
      latch.fail(`потребитель перепрогона остановился: ${event.payload.error.message}`);
      if (event.payload.restart) {
        queueMicrotask(() => {
          void consumer.stop().catch(() => undefined);
        });
      }
    });

    await consumer.connect();
    await consumer.subscribe({ topics: [RAW.name], fromBeginning: true });
    await consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: (payload) => this.handleBatch(execution, payload),
    });
  }

  /**
   * Пачка сырых кадров: нужные сообщения через ядро, дочитанная партиция встаёт на паузу. Дыра
   * перед сообщением значит, что часть окна удалена по сроку хранения: позиция её пропускает.
   */
  private async handleBatch(execution: Execution, payload: EachBatchPayload): Promise<void> {
    const { batch } = payload;
    const { tracker, latch } = execution;
    if (batch.topic !== RAW.name) return;

    for (const message of batch.messages) {
      if (latch.value() !== null || !payload.isRunning() || payload.isStale()) break;
      const lost = tracker.skipLost(batch.partition, message.offset);
      if (lost > 0) {
        this.log.warn(
          { replayRunId: execution.run.id, partition: batch.partition, lost },
          'часть окна перепрогона не прочитана: смещения удалены по сроку хранения',
        );
      }
      if (!tracker.accepts(batch.partition, message.offset)) continue;
      try {
        this.apply(execution.core, batch.partition, message);
      } catch (error) {
        latch.fail(messageOf(error));
        break;
      }
      tracker.advance(batch.partition, message.offset);
      payload.resolveOffset(message.offset);
    }

    if (tracker.isDone(batch.partition)) payload.pause();
    if (tracker.allDone()) latch.done();
    await payload.heartbeat();
  }

  /**
   * Сообщение в ядро. Неразобранное считается отвергнутым, если его ключ это выбранный прибор.
   * Копии повторной подачи из очереди недоставленных пропускаются, как в живом потоке: иначе один
   * кадр окна учитывался бы дважды.
   */
  private apply(core: ReplayCore, partition: number, message: KafkaMessage): void {
    const history = readDlqHistory(message.headers);
    if (history.attempts > 0 || history.redriveOf !== null) return;
    const decoded = decodeMessage(RAW, message.value, message.headers);
    if (!decoded.ok) {
      core.undecodable(message.key?.toString('utf8') ?? null);
      return;
    }
    core.frame(decoded.payload, { partition, offset: message.offset });
  }

  /**
   * Ждёт конца чтения, раз в пульс пишет ход и проверяет предел времени. Запускается вместе
   * с потребителем, поэтому вступление в группу тоже идёт под пульсом. Не бросает: предел времени
   * и отобранный прогон останавливают чтение через сигнал.
   */
  private async watch(
    execution: Execution,
    startedAt: number,
  ): Promise<'done' | 'failed' | 'taken'> {
    const { latch, tracker } = execution;
    for (;;) {
      await latch.wait(this.env.REPLAY_HEARTBEAT_MS);
      const stop = latch.value();
      if (stop !== null) return stop.kind;
      if (this.clock.now() - startedAt >= this.env.REPLAY_MAX_MS) {
        latch.fail(
          `перепрогон не уложился в ${durationText(this.env.REPLAY_MAX_MS)}: прочитано ${String(tracker.offsetsDone())} из ${String(tracker.offsetsTotal)} смещений, возможно, кадры окна уже удалены по сроку хранения`,
        );
        continue;
      }
      if (!(await this.report(execution, null, false))) {
        const settled = latch.value();
        if (settled !== null) return settled.kind;
        latch.fail(TAKEN_STOP);
        return 'taken';
      }
    }
  }

  /**
   * Ход и пульс. false значит, что прогон уже не наш. Сбой базы на первой записи (имя группы
   * до вступления) проваливает прогон, на остальных только пишется в журнал.
   */
  private async report(
    execution: Execution,
    groupId: string | null,
    strict: boolean,
  ): Promise<boolean> {
    const counts = execution.core.counts();
    try {
      return await withTransaction(this.pool, (client) =>
        updateReplayProgress(client, execution.run.id, this.owner(), {
          progress: progressOf(execution),
          coveredFrom: counts.coveredFrom,
          coveredTo: counts.coveredTo,
          groupId,
        }),
      );
    } catch (error) {
      if (strict) throw error;
      if (this.throttle('replay-progress').pass) {
        this.log.warn(
          { err: error, replayRunId: execution.run.id },
          'ход перепрогона не записан, повтор на следующем пульсе',
        );
      }
      return true;
    }
  }

  /**
   * Итог одной транзакцией: завершение первым (оно блокирует строку), затем эпизоды и чистка
   * старых прогонов. Не наш прогон откатывает транзакцию без записи, сбой уходит наверх.
   */
  private async finish(execution: Execution): Promise<void> {
    const { run } = execution;
    const counts = execution.core.counts();
    const episodes = execution.core.episodes();
    const progress = progressOf(execution);
    const owner = { instanceId: this.instanceId };

    try {
      await withTransaction(this.pool, async (client) => {
        const finished = await finishReplayRun(client, run.id, owner, {
          progress,
          coveredFrom: counts.coveredFrom,
          coveredTo: counts.coveredTo,
          finishedAt: toIsoTimestamp(this.clock.now()),
        });
        if (!finished) throw new RunTakenError();
        await insertReplayEpisodes(client, run.id, owner, episodes);
        await pruneReplayRuns(client, REPLAY_KEPT_RUNS);
      });
    } catch (error) {
      if (error instanceof RunTakenError) {
        this.taken(run);
        return;
      }
      throw error;
    }

    this.metrics.observeReplay('done');
    this.log.info(
      { replayRunId: run.id, ...progress, episodes: episodes.length },
      'перепрогон выполнен',
    );
  }

  /** Провал пишется один раз: остановка приложения и сам прогон могут прийти к нему вместе. */
  private failOnce(active: ActiveRun, error: unknown): Promise<void> {
    active.failure ??= this.fail(active.run, error);
    return active.failure;
  }

  /** Прогон завершается с ошибкой на чистом соединении, уже после отката итога. */
  private async fail(run: ReplayRun, error: unknown): Promise<void> {
    this.log.warn({ err: error, replayRunId: run.id }, 'перепрогон не удался');

    try {
      const failed = await withTransaction(this.pool, (client) =>
        failReplayRun(
          client,
          run.id,
          { instanceId: this.instanceId },
          { error: messageOf(error), finishedAt: toIsoTimestamp(this.clock.now()) },
        ),
      );
      this.metrics.observeReplay(failed ? 'failed' : 'taken');
    } catch (failError) {
      this.log.error(
        { err: failError, replayRunId: run.id },
        'сбой перепрогона не записан: прогон завершит проверка пульса',
      );
    }
  }

  private taken(run: ReplayRun): void {
    this.metrics.observeReplay('taken');
    this.log.warn(
      { replayRunId: run.id },
      'перепрогон уже завершён или отобран другим экземпляром: итог не записан',
    );
  }

  /** Потребитель останавливается и отключается, временная группа удаляется, админ отключается. */
  private async release(
    consumer: Consumer | null,
    admin: Admin | null,
    runId: string,
  ): Promise<void> {
    if (consumer !== null) {
      try {
        await consumer.stop();
        await consumer.disconnect();
      } catch (error) {
        this.log.warn({ err: error, replayRunId: runId }, 'потребитель перепрогона не отключился');
      }
    }
    if (admin === null) return;

    if (consumer !== null) await this.deleteGroup(admin, replayGroupIdOf(runId));
    try {
      await admin.disconnect();
    } catch (error) {
      this.log.warn({ err: error, replayRunId: runId }, 'клиент администрирования не отключился');
    }
  }

  /**
   * Удаление временной группы. Брокер удаляет только пустую группу, а участник выходит из неё
   * не мгновенно, поэтому несколько попыток с паузой. Уже удалённая группа это успех.
   */
  private async deleteGroup(admin: Admin, groupId: string): Promise<void> {
    if (!groupId.startsWith(REPLAY_GROUP_PREFIX)) return;

    for (let attempt = 0; ; attempt += 1) {
      try {
        await admin.deleteGroups([groupId]);
        return;
      } catch (error) {
        const codes = deleteGroupCodes(error);
        if (codes.length > 0 && codes.every((code) => code === GROUP_ID_NOT_FOUND)) return;
        const delay = DELETE_GROUP_DELAYS_MS[attempt];
        if (delay === undefined) {
          this.log.warn(
            { err: error, groupId },
            'временная группа перепрогона не удалена: пустую группу брокер уберёт сам',
          );
          return;
        }
        await sleep(delay);
      }
    }
  }

  private owner(): ReplayRunOwner {
    return { instanceId: this.instanceId, heartbeatAt: toIsoTimestamp(this.clock.now()) };
  }
}
