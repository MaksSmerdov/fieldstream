import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import type pg from 'pg';
import {
  REPLAY_EPISODES_LIMIT,
  REPLAY_RETENTION_MS,
  replayEpisodesQuerySchema,
  replayRequestSchema,
} from '@fieldstream/contracts';
import type {
  ReplayDiff,
  ReplayEpisodesResponse,
  ReplayRun,
  ReplayRunsResponse,
} from '@fieldstream/contracts';
import {
  countLiveAlarmEpisodes,
  createReplayRun,
  failExpiredQueuedReplayRuns,
  loadActiveReplayRun,
  loadAlarmRules,
  loadRecentReplayRuns,
  loadReplayEpisodeSummary,
  loadReplayEpisodes,
  loadReplayRun,
  loadReplayRunRules,
  withTransaction,
} from '@fieldstream/db';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import type { Logger } from '@fieldstream/nest-common';
import { CurrentUser, RequirePermission } from '../auth/auth.guard.js';
import type { AccessClaims } from '../auth/tokens.js';
import { withClient } from '../common/with-client.js';
import type { Env } from '../config/env.js';
import { DeviceRefsService } from '../topology/device-refs.service.js';
import { CLOCK, ENV, LOGGER, POOL } from '../tokens.js';
import {
  REPLAY_RECENT_RUNS,
  applyPatches,
  busyMessage,
  changedRulesOf,
  diffRowsOf,
  liveWindowOf,
  millisecondWindowOf,
  parseRulesSnapshot,
  replayErrorMap,
  unfinishedMessage,
  unknownDevicesOf,
  windowIssues,
} from './replay-calc.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const QUEUE_EXPIRED_ERROR =
  'ни один процессор не забрал прогон: перепрогон выключен или процессор не запущен';

/** Чтение итога прогона: прогона нет, он ещё не завершён успешно или итог прочитан. */
type FinishedRead<T> =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unfinished'; readonly run: ReplayRun }
  | { readonly kind: 'ready'; readonly run: ReplayRun; readonly result: T };

/** Номер прогона из пути: не uuid это ошибка запроса. */
const ensureRunId = (id: string): void => {
  if (!UUID.test(id)) throw new BadRequestException('номер прогона это uuid');
};

/** Итог прочитанного прогона или ответ 404 и 409. */
const readyOf = <T>(
  id: string,
  read: FinishedRead<T>,
): { readonly run: ReplayRun; readonly result: T } => {
  if (read.kind === 'missing') throw new NotFoundException(`прогона ${id} нет`);
  if (read.kind === 'unfinished') throw new ConflictException(unfinishedMessage(read.run));

  return read;
};

@Controller('replay-runs')
export class ReplayController {
  public constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly log: Logger,
    private readonly refs: DeviceRefsService,
  ) {}

  /** Последние прогоны, идущий сейчас и срок хранения, в пределах которого выбирается окно. */
  @Get()
  @RequirePermission('replay')
  public async list(): Promise<ReplayRunsResponse> {
    await withClient(this.pool, (client) => this.expireQueued(client));
    const { runs, activeRun } = await this.readSnapshot(async (client) => ({
      runs: await loadRecentReplayRuns(client, REPLAY_RECENT_RUNS),
      activeRun: await loadActiveReplayRun(client),
    }));

    return {
      serverTime: toIsoTimestamp(this.clock.now()),
      retentionMs: REPLAY_RETENTION_MS,
      runs,
      activeRun,
    };
  }

  /**
   * Постановка перепрогона. В брокер шлюз не пишет: запрос со снимком уставок обоих вариантов
   * ложится в базу, исполняет его процессор. Прогон на стенде один, занятый стенд это 409.
   */
  @Post()
  @HttpCode(202)
  @RequirePermission('replay.run')
  public async start(
    @Body() body: unknown,
    @CurrentUser() claims: AccessClaims,
  ): Promise<ReplayRun> {
    const parsed = replayRequestSchema.safeParse(body, { errorMap: replayErrorMap });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message));
    }
    const request = millisecondWindowOf(parsed.data);

    const outOfWindow = windowIssues(request, this.clock.now());
    if (outOfWindow.length > 0) throw new BadRequestException(outOfWindow);

    if (!this.refs.isLoaded()) {
      throw new ServiceUnavailableException(
        'топология стенда ещё не прочитана, повторите запуск позже',
      );
    }
    const unknownDevices = unknownDevicesOf(request.deviceCodes, this.refs.current());
    if (unknownDevices.length > 0) {
      throw new BadRequestException(unknownDevices.map((code) => `прибора ${code} нет на стенде`));
    }

    const run = await withClient(this.pool, async (client) => {
      const baseline = await loadAlarmRules(client, {
        deviceCodes: request.deviceCodes,
        includeDisabled: true,
      });
      const patched = applyPatches(baseline, request.patches);
      if (!patched.ok) throw new BadRequestException(patched.issues);

      await this.expireQueued(client);
      const created = await createReplayRun(client, {
        requestedBy: claims.email,
        from: request.from,
        to: request.to,
        deviceCodes: request.deviceCodes,
        patches: request.patches,
        rulesBaseline: baseline,
        rulesPatched: patched.rules,
      });
      if (created === null) {
        throw new ConflictException(busyMessage(await loadActiveReplayRun(client)));
      }

      return created;
    });

    this.log.info(
      {
        user: claims.email,
        runId: run.id,
        from: run.from,
        to: run.to,
        devices: run.deviceCodes.length,
        patches: run.patches.length,
      },
      'перепрогон поставлен в очередь',
    );

    return run;
  }

  /** Прогон с ходом: ждёт процессор, идёт или завершён со счётами и покрытием. */
  @Get(':id')
  @RequirePermission('replay')
  public async progress(@Param('id') id: string): Promise<ReplayRun> {
    ensureRunId(id);

    const run = await withClient(this.pool, (client) => loadReplayRun(client, id));
    if (run === null) throw new NotFoundException(`прогона ${id} нет`);

    return run;
  }

  /** Итог завершённого прогона: изменённые уставки и строки разницы с живыми эпизодами за покрытие. */
  @Get(':id/diff')
  @RequirePermission('replay')
  public async diff(@Param('id') id: string): Promise<ReplayDiff> {
    ensureRunId(id);

    const { run, result } = readyOf(
      id,
      await this.readFinished(id, async (client, finished) => {
        const window = liveWindowOf(finished);
        return {
          rules: await loadReplayRunRules(client, id),
          summary: await loadReplayEpisodeSummary(client, id),
          live: window === null ? [] : await countLiveAlarmEpisodes(client, window),
        };
      }),
    );

    const snapshot = result.rules === null ? null : parseRulesSnapshot(result.rules);
    if (snapshot === null || !snapshot.ok) {
      this.log.error(
        { runId: id, issues: snapshot?.issues ?? ['снимка уставок в строке прогона нет'] },
        'снимок уставок перепрогона не разбирается',
      );
      throw new InternalServerErrorException(
        'снимок уставок прогона испорчен, подробности в журнале',
      );
    }

    return {
      run,
      changedRules: changedRulesOf(snapshot.snapshot),
      rows: diffRowsOf(result.summary, result.live),
    };
  }

  /** Эпизоды обоих вариантов одной строки разницы: их рисует график. Сверх предела только первые. */
  @Get(':id/episodes')
  @RequirePermission('replay')
  public async episodes(
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<ReplayEpisodesResponse> {
    ensureRunId(id);

    const parsed = replayEpisodesQuerySchema.safeParse(query, { errorMap: replayErrorMap });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message));
    }

    const { run, result } = readyOf(
      id,
      await this.readFinished(id, (client) =>
        loadReplayEpisodes(client, id, parsed.data, REPLAY_EPISODES_LIMIT + 1),
      ),
    );

    return {
      runId: run.id,
      ...parsed.data,
      baseline: result.baseline.slice(0, REPLAY_EPISODES_LIMIT),
      patched: result.patched.slice(0, REPLAY_EPISODES_LIMIT),
      truncated:
        result.baseline.length > REPLAY_EPISODES_LIMIT ||
        result.patched.length > REPLAY_EPISODES_LIMIT,
    };
  }

  /**
   * Снимает с очереди прогоны, которые ни один процессор не забрал вовремя: иначе такой прогон
   * держит стенд занятым навсегда. Порог и момент завершения по часам базы, как и created_at:
   * часы шлюза могут разойтись с ними, и тогда снимался бы только что поставленный прогон.
   */
  private async expireQueued(client: pg.ClientBase): Promise<void> {
    const clock = await client.query<{ now: Date }>('SELECT now() AS now');
    const nowMs = clock.rows[0]?.now.getTime();
    if (nowMs === undefined) return;

    const failed = await failExpiredQueuedReplayRuns(
      client,
      { queuedBefore: toIsoTimestamp(nowMs - this.env.REPLAY_QUEUE_TIMEOUT_MS) },
      QUEUE_EXPIRED_ERROR,
      toIsoTimestamp(nowMs),
    );
    if (failed > 0) {
      this.log.warn(
        { failed, timeoutMs: this.env.REPLAY_QUEUE_TIMEOUT_MS },
        'перепрогоны, которые не забрал ни один процессор, сняты с очереди',
      );
    }
  }

  /**
   * Чтение одним снимком базы только на чтение: все запросы внутри видят одно состояние.
   * Запись в снимке не делается, иначе параллельный захват прогона процессором дал бы ошибку
   * сериализации.
   */
  private readSnapshot<T>(read: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      return read(client);
    });
  }

  /**
   * Прогон и его итог одним снимком базы: чистка старых прогонов между запросами иначе дала бы
   * пустой итог вместо 404.
   */
  private readFinished<T>(
    id: string,
    read: (client: pg.PoolClient, run: ReplayRun) => Promise<T>,
  ): Promise<FinishedRead<T>> {
    return this.readSnapshot(async (client): Promise<FinishedRead<T>> => {
      const run = await loadReplayRun(client, id);
      if (run === null) return { kind: 'missing' };
      if (run.status !== 'done') return { kind: 'unfinished', run };

      return { kind: 'ready', run, result: await read(client, run) };
    });
  }
}
