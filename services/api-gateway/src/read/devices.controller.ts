import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import type pg from 'pg';
import {
  alarmRulesUpdateSchema,
  deviceEventsQuerySchema,
  pickSource,
  planModeSchema,
  seriesQuerySchema,
} from '@fieldstream/contracts';
import type {
  AlarmRulesResponse,
  AlarmRulesUpdateResponse,
  DeviceEventsResponse,
  DeviceProfileView,
  DeviceSnapshot,
  ReadPlanResponse,
  SeriesResponse,
} from '@fieldstream/contracts';
import {
  loadDeviceAlarmRules,
  loadDeviceEvents,
  loadDeviceSnapshot,
  loadSeries,
  updateDeviceAlarmRules,
} from '@fieldstream/db';
import { buildDeviceReadPlan, profileByVersion } from '@fieldstream/device-profiles';
import { buildModeSpans, toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import { CurrentUser, RequirePermission } from '../auth/auth.guard.js';
import type { AccessClaims } from '../auth/tokens.js';
import { withClient } from '../common/with-client.js';
import { CLOCK, POOL } from '../tokens.js';

/** Сколько тактов опроса подряд можно не получать данные, прежде чем снимок считается устаревшим. */
const STALE_CYCLES = 3;

/** Потолок происшествий за окно: неделя оттаек на дюжине приборов в него укладывается с запасом. */
const EVENTS_LIMIT = 500;

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

  /**
   * Происшествия прибора за окно и полоса режимов по ним. Отрезки считает сервер: режим
   * на начало окна известен только базе, а без него первый отрезок пришлось бы додумывать.
   */
  @Get(':code/events')
  @RequirePermission('devices')
  public async events(
    @Param('code') code: string,
    @Query() query: unknown,
  ): Promise<DeviceEventsResponse> {
    const parsed = deviceEventsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message));
    }
    if (Date.parse(parsed.data.to) <= Date.parse(parsed.data.from)) {
      throw new BadRequestException('конец окна должен быть позже начала');
    }

    const data = await withClient(this.pool, (client) =>
      loadDeviceEvents(client, { deviceCode: code, ...parsed.data, limit: EVENTS_LIMIT }),
    );
    if (data === null) throw new NotFoundException(`прибора ${code} нет в топологии`);

    return {
      deviceCode: code,
      from: parsed.data.from,
      to: parsed.data.to,
      spans: buildModeSpans({
        from: parsed.data.from,
        to: parsed.data.to,
        initialMode: data.initialMode,
        changes: data.changes,
      }),
      events: [...data.events],
      serverTime: toIsoTimestamp(this.clock.now()),
    };
  }

  /** Уставки прибора по режимам: в оттайке границы свои, и это видно прямо в списке. */
  @Get(':code/alarm-rules')
  @RequirePermission('devices')
  public async alarmRules(@Param('code') code: string): Promise<AlarmRulesResponse> {
    const rules = await withClient(this.pool, (client) => loadDeviceAlarmRules(client, code));
    if (rules.length === 0) {
      const snapshot = await withClient(this.pool, (client) => loadDeviceSnapshot(client, code));
      if (snapshot === null) throw new NotFoundException(`прибора ${code} нет в топологии`);
    }

    return { deviceCode: code, rules };
  }

  /**
   * Правка уставок. Уставка и запись в историю правок идут одной транзакцией, поэтому
   * изменение без следа невозможно. Через несколько секунд новые значения подхватит процессор.
   */
  @Put(':code/alarm-rules')
  @RequirePermission('alarm-rules.edit')
  public async updateAlarmRules(
    @Param('code') code: string,
    @Body() body: unknown,
    @CurrentUser() claims: AccessClaims,
  ): Promise<AlarmRulesUpdateResponse> {
    const parsed = alarmRulesUpdateSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message));
    }

    const result = await withClient(this.pool, (client) =>
      updateDeviceAlarmRules(
        client,
        code,
        parsed.data.rules,
        claims.email,
        toIsoTimestamp(this.clock.now()),
      ),
    );
    if (result === null) throw new NotFoundException(`прибора ${code} нет в топологии`);

    return { deviceCode: code, changes: result.changes, rules: result.rules };
  }

  /**
   * Описание модели прибора: секции и параметры в порядке профиля. Нужно экрану, чтобы
   * группировать значения и рисовать перечисления словами, а не кодами.
   */
  @Get(':code/profile')
  @RequirePermission('devices')
  public async profile(@Param('code') code: string): Promise<DeviceProfileView> {
    const snapshot = await withClient(this.pool, (client) => loadDeviceSnapshot(client, code));
    if (snapshot === null) throw new NotFoundException(`прибора ${code} нет в топологии`);

    const profile = profileByVersion(snapshot.profileKey, snapshot.profileVersion);
    if (profile === undefined) {
      throw new NotFoundException(
        `нет профиля ${snapshot.profileKey} версии ${String(snapshot.profileVersion)}`,
      );
    }

    return {
      deviceCode: code,
      profileKey: profile.profileKey,
      profileVersion: profile.version,
      label: profile.label,
      sections: profile.sections.map((section) => ({
        key: section.key,
        label: section.label,
        params: section.params.map((param) => ({
          metricKey: param.key,
          label: param.label,
          unit: param.unit ?? null,
          precision: param.precision,
          kind: param.bits !== undefined ? 'bits' : param.enum !== undefined ? 'enum' : 'number',
          states: param.enum ?? null,
          bits:
            param.bits?.map((bit) => ({ bit: bit.bit, key: bit.key, label: bit.label })) ?? null,
          range: param.range === undefined ? null : { min: param.range.min, max: param.range.max },
        })),
      })),
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
