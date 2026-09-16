import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type pg from 'pg';
import { Public } from '../auth/auth.guard.js';
import { KafkaBridgeService } from '../events/kafka-bridge.service.js';
import type { BridgeState } from '../events/kafka-bridge.service.js';
import { LiveBusService } from '../events/live-bus.service.js';
import { POOL } from '../tokens.js';

interface Readiness {
  readonly status: 'ready' | 'starting';
  readonly database: boolean;
  readonly broker: BridgeState;
  readonly streams: number;
}

/**
 * Живость и готовность. Готов, когда база отвечает: без неё шлюзу нечего отдавать. Мост,
 * выключенный настройкой, так и отдаётся выключенным и готовности не мешает: исправным
 * брокером он не притворяется.
 */
@Public()
@Controller('health')
export class HealthController {
  public constructor(
    @Inject(POOL) private readonly pool: pg.Pool,
    private readonly bus: LiveBusService,
    private readonly bridge: KafkaBridgeService,
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
    const broker = this.bridge.state();
    const readiness: Readiness = {
      status: database && broker !== 'down' ? 'ready' : 'starting',
      database,
      broker,
      streams: this.bus.openStreams(),
    };

    if (readiness.status !== 'ready') throw new ServiceUnavailableException(readiness);
    return readiness;
  }
}
