import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type pg from 'pg';
import type { Clock } from '@fieldstream/domain';
import type { Logger } from '@fieldstream/nest-common';
import type { Env } from './config/env.js';
import { EventsController } from './events/events.controller.js';
import { LiveBusService } from './events/live-bus.service.js';
import { HealthController } from './http/health.controller.js';
import { MetricsController } from './http/metrics.controller.js';
import type { GatewayMetrics } from './metrics/metrics.js';
import { CLOCK, ENV, INSTANCE_ID, LOGGER, METRICS, POOL } from './tokens.js';

export interface AppDeps {
  readonly env: Env;
  readonly log: Logger;
  readonly clock: Clock;
  readonly metrics: GatewayMetrics;
  readonly pool: pg.Pool;
  readonly instanceId: string;
}

/** Модуль шлюза. Окружение, логгер, часы и пул соединений создаёт точка входа. */
@Module({})
export class AppModule {
  public static register(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, MetricsController, EventsController],
      providers: [
        { provide: ENV, useValue: deps.env },
        { provide: LOGGER, useValue: deps.log },
        { provide: CLOCK, useValue: deps.clock },
        { provide: METRICS, useValue: deps.metrics },
        { provide: POOL, useValue: deps.pool },
        { provide: INSTANCE_ID, useValue: deps.instanceId },
        LiveBusService,
      ],
    };
  }
}
