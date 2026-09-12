import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type pg from 'pg';
import { LiveBusService } from '../events/live-bus.service.js';
import { POOL } from '../tokens.js';

interface Readiness {
  readonly status: 'ready' | 'starting';
  readonly database: boolean;
  readonly streams: number;
}

/** Живость и готовность. Готов, когда база отвечает: без неё шлюзу нечего отдавать. */
@Controller('health')
export class HealthController {
  public constructor(
    @Inject(POOL) private readonly pool: pg.Pool,
    private readonly bus: LiveBusService,
  ) {}

  @Get('live')
  public live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  public async ready(): Promise<Readiness> {
    const database = await this.pool
      .query('SELECT 1')
      .then(() => true)
      .catch(() => false);
    const readiness: Readiness = {
      status: database ? 'ready' : 'starting',
      database,
      streams: this.bus.openStreams(),
    };

    if (readiness.status !== 'ready') throw new ServiceUnavailableException(readiness);
    return readiness;
  }
}
