import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type pg from 'pg';
import type { Clock } from '@fieldstream/domain';
import type { Logger } from '@fieldstream/nest-common';
import { AlarmRulesService } from './alarms/alarm-rules.service.js';
import { CommandResultsService } from './commands/results-consumer.service.js';
import type { Env } from './config/env.js';
import { HealthService } from './health/health.service.js';
import { HealthController } from './http/health.controller.js';
import { MetricsController } from './http/metrics.controller.js';
import { CyclesConsumerService } from './ingest/cycles-consumer.service.js';
import { RawConsumerService } from './ingest/raw-consumer.service.js';
import type { ProcessorMetrics } from './metrics/metrics.js';
import { ProducerService } from './publish/producer.service.js';
import { DeviceRefsService } from './topology/device-refs.service.js';
import { CLOCK, ENV, LOGGER, METRICS, POOL } from './tokens.js';

export interface AppDeps {
  readonly env: Env;
  readonly log: Logger;
  readonly clock: Clock;
  readonly metrics: ProcessorMetrics;
  readonly pool: pg.Pool;
}

/** Модуль процессора. Окружение, логгер, часы и пул соединений создаёт точка входа. */
@Module({})
export class AppModule {
  public static register(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, MetricsController],
      providers: [
        { provide: ENV, useValue: deps.env },
        { provide: LOGGER, useValue: deps.log },
        { provide: CLOCK, useValue: deps.clock },
        { provide: METRICS, useValue: deps.metrics },
        { provide: POOL, useValue: deps.pool },
        ProducerService,
        DeviceRefsService,
        AlarmRulesService,
        HealthService,
        RawConsumerService,
        CyclesConsumerService,
        CommandResultsService,
      ],
    };
  }
}
