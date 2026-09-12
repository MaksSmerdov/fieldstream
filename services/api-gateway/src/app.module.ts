import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type pg from 'pg';
import type { Clock } from '@fieldstream/domain';
import type { Logger } from '@fieldstream/nest-common';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { MeController } from './auth/me.controller.js';
import type { Env } from './config/env.js';
import { EventsController } from './events/events.controller.js';
import { KafkaBridgeService } from './events/kafka-bridge.service.js';
import { LiveBusService } from './events/live-bus.service.js';
import { HealthController } from './http/health.controller.js';
import { MetricsController } from './http/metrics.controller.js';
import type { GatewayMetrics } from './metrics/metrics.js';
import { AlarmsController } from './read/alarms.controller.js';
import { DevicesController } from './read/devices.controller.js';
import { TopologyController } from './read/topology.controller.js';
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
      controllers: [
        HealthController,
        MetricsController,
        EventsController,
        AuthController,
        MeController,
        TopologyController,
        DevicesController,
        AlarmsController,
      ],
      providers: [
        { provide: ENV, useValue: deps.env },
        { provide: LOGGER, useValue: deps.log },
        { provide: CLOCK, useValue: deps.clock },
        { provide: METRICS, useValue: deps.metrics },
        { provide: POOL, useValue: deps.pool },
        { provide: INSTANCE_ID, useValue: deps.instanceId },
        { provide: APP_GUARD, useClass: AuthGuard },
        AuthService,
        LiveBusService,
        KafkaBridgeService,
      ],
    };
  }
}
