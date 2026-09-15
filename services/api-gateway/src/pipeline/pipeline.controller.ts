import { Controller, Get, Inject } from '@nestjs/common';
import type pg from 'pg';
import type { PipelineResponse } from '@fieldstream/contracts';
import { loadDlqCounts } from '@fieldstream/db';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import { RequirePermission } from '../auth/auth.guard.js';
import { withClient } from '../common/with-client.js';
import { LiveBusService } from '../events/live-bus.service.js';
import { CLOCK, POOL } from '../tokens.js';
import { PipelineSamplerService } from './pipeline-sampler.service.js';

@Controller('pipeline')
export class PipelineController {
  public constructor(
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly sampler: PipelineSamplerService,
    private readonly bus: LiveBusService,
  ) {}

  /** Снимок конвейера из последнего опроса брокера. Очередь недоставленных считается на запрос. */
  @Get()
  @RequirePermission('pipeline')
  public async snapshot(): Promise<PipelineResponse> {
    const dlq = await withClient(this.pool, (client) => loadDlqCounts(client));
    const view = this.sampler.current();

    return {
      serverTime: toIsoTimestamp(this.clock.now()),
      sampledAt: view.sampledAt,
      brokerError: view.brokerError,
      topics: view.topics,
      groups: view.groups,
      rebalances: view.rebalances,
      dlq: { unresolved: dlq.unresolved, total: dlq.total },
      live: { streams: this.bus.openStreams(), eventsPerSec: this.sampler.eventsPerSec() },
    };
  }
}
