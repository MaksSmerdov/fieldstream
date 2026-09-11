import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { TOPICS } from '@fieldstream/contracts';
import { SystemClock } from '@fieldstream/domain';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { NestPinoLogger, createLogger } from './logging/logger.js';
import { createMetrics } from './metrics/metrics.js';

const env = loadEnv(process.env);
const log = createLogger(env.LOG_LEVEL);

const app = await NestFactory.create<NestFastifyApplication>(
  AppModule.register({ env, log, clock: SystemClock, metrics: createMetrics() }),
  new FastifyAdapter(),
  { logger: new NestPinoLogger(log) },
);
app.enableShutdownHooks();
await app.listen(env.COLLECTOR_HTTP_PORT, env.COLLECTOR_HOST);

log.info(
  { brokers: env.KAFKA_BROKERS, modbusHost: env.MODBUS_HOST_OVERRIDE ?? 'из стенда' },
  'edge-collector: опрос линий Modbus TCP',
);
log.info(
  { produces: [TOPICS.telemetryRaw.name, TOPICS.pollCycles.name] },
  'пишет сырые кадры и события циклов опроса',
);
log.info(
  { port: env.COLLECTOR_HTTP_PORT },
  'GET /health/live, /health/ready, /metrics, /internal/lines',
);
