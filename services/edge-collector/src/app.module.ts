import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Clock } from '@fieldstream/domain';
import type { Env } from './config/env.js';
import { HealthController } from './http/health.controller.js';
import { InternalController } from './http/internal.controller.js';
import { MetricsController } from './http/metrics.controller.js';
import { LinesService } from './lines/lines.service.js';
import type { Logger } from '@fieldstream/nest-common';
import type { CollectorMetrics } from './metrics/metrics.js';
import { KafkaPublisher } from './publish/kafka-publisher.js';
import { CLOCK, ENV, LOGGER, METRICS } from './tokens.js';

export interface AppDeps {
  readonly env: Env;
  readonly log: Logger;
  readonly clock: Clock;
  readonly metrics: CollectorMetrics;
}

/** Модуль сборщика. Окружение, логгер и часы приходят снаружи: их создаёт точка входа. */
@Module({})
export class AppModule {
  public static register(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, MetricsController, InternalController],
      providers: [
        { provide: ENV, useValue: deps.env },
        { provide: LOGGER, useValue: deps.log },
        { provide: CLOCK, useValue: deps.clock },
        { provide: METRICS, useValue: deps.metrics },
        KafkaPublisher,
        LinesService,
      ],
    };
  }
}
