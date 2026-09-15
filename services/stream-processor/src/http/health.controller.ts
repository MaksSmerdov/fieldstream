import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { IngestConsumerService } from '../ingest/ingest-consumer.service.js';
import { ProducerService } from '../publish/producer.service.js';
import { DeviceRefsService } from '../topology/device-refs.service.js';

interface Readiness {
  readonly status: 'ready' | 'starting';
  readonly kafka: boolean;
  readonly topology: boolean;
  readonly consumers: boolean;
}

/** Живость и готовность. Готов, когда есть связь с Kafka, топология загружена и потребитель кадров и циклов работает. */
@Controller('health')
export class HealthController {
  public constructor(
    private readonly producer: ProducerService,
    private readonly refs: DeviceRefsService,
    private readonly ingest: IngestConsumerService,
  ) {}

  @Get('live')
  public live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  public ready(): Readiness {
    const kafka = this.producer.isConnected();
    const topology = this.refs.isLoaded();
    const consumers = this.ingest.isRunning();
    const readiness: Readiness = {
      status: kafka && topology && consumers ? 'ready' : 'starting',
      kafka,
      topology,
      consumers,
    };

    if (readiness.status !== 'ready') throw new ServiceUnavailableException(readiness);
    return readiness;
  }
}
