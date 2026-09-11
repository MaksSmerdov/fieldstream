import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { CollectorMetrics } from '../metrics/metrics.js';
import { METRICS } from '../tokens.js';

/** Метрики в текстовом формате Prometheus. */
@Controller('metrics')
export class MetricsController {
  private readonly metrics: CollectorMetrics;

  public constructor(@Inject(METRICS) metrics: CollectorMetrics) {
    this.metrics = metrics;
  }

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  public async scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
