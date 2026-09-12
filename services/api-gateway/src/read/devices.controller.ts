import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import type pg from 'pg';
import { pickSource, planModeSchema, seriesQuerySchema } from '@fieldstream/contracts';
import type { DeviceSnapshot, ReadPlanResponse, SeriesResponse } from '@fieldstream/contracts';
import { loadDeviceSnapshot, loadSeries } from '@fieldstream/db';
import { buildDeviceReadPlan, profileByVersion } from '@fieldstream/device-profiles';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import { RequirePermission } from '../auth/auth.guard.js';
import { withClient } from '../common/with-client.js';
import { CLOCK, POOL } from '../tokens.js';

/** Сколько тактов опроса подряд можно не получать данные, прежде чем снимок считается устаревшим. */
const STALE_CYCLES = 3;

@Controller('devices')
export class DevicesController {
  public constructor(
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Последние значения прибора. Признак устаревания считает сервер по своим часам. */
  @Get(':code/latest')
  @RequirePermission('devices')
  public async latest(@Param('code') code: string): Promise<DeviceSnapshot> {
    const snapshot = await withClient(this.pool, (client) => loadDeviceSnapshot(client, code));
    if (snapshot === null) throw new NotFoundException(`прибора ${code} нет в топологии`);

    const nowMs = this.clock.now();
    const lastMs = snapshot.ts === null ? null : Date.parse(snapshot.ts);
    const { pollIntervalMs, ...rest } = snapshot;

    return {
      ...rest,
      stale: lastMs === null || nowMs - lastMs > pollIntervalMs * STALE_CYCLES,
      serverTime: toIsoTimestamp(nowMs),
    };
  }

  /**
   * Серия за окно. Источник и шаг выбирает та же чистая функция, что и фронт, а ответ несёт
   * их рядом с данными: подпись под графиком физически не может разойтись с тем, откуда взяты числа.
   */
  @Get(':code/series')
  @RequirePermission('devices')
  public async series(
    @Param('code') code: string,
    @Query() query: unknown,
  ): Promise<SeriesResponse> {
    const parsed = seriesQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message));
    }

    const fromMs = Date.parse(parsed.data.from);
    const toMs = Date.parse(parsed.data.to);
    if (toMs <= fromMs) throw new BadRequestException('конец окна должен быть позже начала');

    const plan = pickSource(toMs - fromMs, parsed.data.maxPoints);
    const metrics = await withClient(this.pool, (client) =>
      loadSeries(client, {
        deviceCode: code,
        metricKeys: parsed.data.metrics,
        from: parsed.data.from,
        to: parsed.data.to,
        source: plan.source,
        bucketMs: plan.bucketMs,
      }),
    );

    return {
      deviceCode: code,
      metrics,
      meta: {
        source: plan.source,
        bucketMs: plan.bucketMs,
        points: plan.points,
        truncated: plan.truncated,
        from: parsed.data.from,
        to: parsed.data.to,
      },
    };
  }

  /** Карта регистров: тот же план, что уходит на линию, в склеенном или поштучном виде. */
  @Get(':code/read-plan')
  @RequirePermission('devices')
  public async readPlan(
    @Param('code') code: string,
    @Query('mode') mode: string | undefined,
  ): Promise<ReadPlanResponse> {
    const parsedMode = planModeSchema.safeParse(mode ?? 'merged');
    if (!parsedMode.success) throw new BadRequestException('режим плана это merged или naive');

    const snapshot = await withClient(this.pool, (client) => loadDeviceSnapshot(client, code));
    if (snapshot === null) throw new NotFoundException(`прибора ${code} нет в топологии`);

    const profile = profileByVersion(snapshot.profileKey, snapshot.profileVersion);
    if (profile === undefined) {
      throw new NotFoundException(
        `нет профиля ${snapshot.profileKey} версии ${String(snapshot.profileVersion)}`,
      );
    }

    const plan = buildDeviceReadPlan(profile, { mode: parsedMode.data });

    return {
      deviceCode: code,
      profileKey: profile.profileKey,
      profileVersion: profile.version,
      mode: parsedMode.data,
      requests: plan.blocks.length,
      registers: plan.blocks.reduce((total, block) => total + block.registerCount, 0),
      blocks: plan.blocks.map((block) => ({
        id: block.id,
        registerType: block.registerType,
        startAddress: block.startAddress,
        registerCount: block.registerCount,
        paramKeys: [...block.paramKeys],
        source: block.source,
      })),
    };
  }
}
