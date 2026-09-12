import { Controller, Get, Inject } from '@nestjs/common';
import type pg from 'pg';
import type { TopologyResponse } from '@fieldstream/contracts';
import { loadTopologyTree } from '@fieldstream/db';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import { RequirePermission } from '../auth/auth.guard.js';
import { withClient } from '../common/with-client.js';
import { CLOCK, POOL } from '../tokens.js';

/** Дерево объектов для бокового меню и обзорного экрана. */
@Controller('topology')
export class TopologyController {
  public constructor(
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @RequirePermission('overview')
  public async tree(): Promise<TopologyResponse> {
    const sites = await withClient(this.pool, (client) => loadTopologyTree(client));

    return { sites, serverTime: toIsoTimestamp(this.clock.now()) };
  }
}
