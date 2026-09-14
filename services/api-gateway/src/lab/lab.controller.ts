import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
} from '@nestjs/common';
import { labFaultRequestSchema, simClearFaultsQuerySchema } from '@fieldstream/contracts';
import type {
  LabFaultsResponse,
  LabLinesResponse,
  SimClearFaultsResult,
  SimFault,
} from '@fieldstream/contracts';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import type { Logger } from '@fieldstream/nest-common';
import { CurrentUser, RequirePermission } from '../auth/auth.guard.js';
import type { AccessClaims } from '../auth/tokens.js';
import { CLOCK, LOGGER } from '../tokens.js';
import { LineStatusService } from './line-status.service.js';
import { SimClientService } from './sim-client.service.js';

@Controller('lab')
export class LabController {
  public constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly log: Logger,
    private readonly status: LineStatusService,
    private readonly sim: SimClientService,
  ) {}

  /** Последние снимки линий от сборщика. */
  @Get('lines')
  @RequirePermission('lab')
  public lines(): LabLinesResponse {
    return { serverTime: toIsoTimestamp(this.clock.now()), lines: this.status.lines() };
  }

  /** Действующие поломки стенда. */
  @Get('faults')
  @RequirePermission('lab')
  public async faults(): Promise<LabFaultsResponse> {
    const state = await this.sim.state();

    return { serverTime: toIsoTimestamp(this.clock.now()), faults: state.faults };
  }

  /** Внесение поломки. Неверное описание отвергается здесь и до стенда не доходит. */
  @Post('faults')
  @HttpCode(201)
  @RequirePermission('lab.inject')
  public async inject(
    @Body() body: unknown,
    @CurrentUser() claims: AccessClaims,
  ): Promise<SimFault> {
    const parsed = labFaultRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message));
    }

    const fault = await this.sim.injectFault(parsed.data);
    this.log.info(
      {
        user: claims.email,
        faultId: fault.id,
        kind: fault.kind,
        targetKind: fault.targetKind,
        targetId: fault.targetId,
        expiresAt: fault.expiresAt,
      },
      'поломка внесена на стенд',
    );

    return fault;
  }

  /** Снятие поломок по фильтру цели и вида. Без фильтров снимаются все. */
  @Delete('faults')
  @RequirePermission('lab.inject')
  public async clear(
    @Query() query: unknown,
    @CurrentUser() claims: AccessClaims,
  ): Promise<SimClearFaultsResult> {
    const parsed = simClearFaultsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message));
    }

    const result = await this.sim.clearFaults(parsed.data);
    this.log.info(
      { user: claims.email, filter: parsed.data, removed: result.removed },
      'поломки сняты со стенда',
    );

    return result;
  }
}
