import { Controller, Get, Header, Inject } from '@nestjs/common';
import { Public } from '../auth/auth.guard.js';
import type { GatewayMetrics } from '../metrics/metrics.js';
import { METRICS } from '../tokens.js';

/** Метрики в текстовом формате Prometheus: их снимает сборщик, а не браузер. */
@Public()
@Controller('metrics')
export class MetricsController {
  public constructor(@Inject(METRICS) private readonly metrics: GatewayMetrics) {}

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  public async scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
