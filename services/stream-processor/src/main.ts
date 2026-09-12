import 'reflect-metadata';
import pg from 'pg';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { TOPICS } from '@fieldstream/contracts';
import { ROLES, connectionUrl } from '@fieldstream/db';
import { SystemClock } from '@fieldstream/domain';
import { NestPinoLogger, createLogger } from '@fieldstream/nest-common';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { createMetrics } from './metrics/metrics.js';

const env = loadEnv(process.env);
const log = createLogger('stream-processor', env.LOG_LEVEL);
const pool = new pg.Pool({
  connectionString: connectionUrl(
    { host: env.DATABASE_HOST, port: env.DATABASE_PORT, database: env.POSTGRES_DB },
    ROLES.ingest,
    env.FS_INGEST_PASSWORD,
  ),
  max: 6,
});
pool.on('error', (error) => {
  log.warn({ err: error }, 'соединение пула базы оборвалось');
});

const app = await NestFactory.create<NestFastifyApplication>(
  AppModule.register({ env, log, clock: SystemClock, metrics: createMetrics(), pool }),
  new FastifyAdapter(),
  { logger: new NestPinoLogger(log) },
);
app.enableShutdownHooks();
await app.listen(env.PROCESSOR_HTTP_PORT, env.PROCESSOR_HOST);

log.info(
  { brokers: env.KAFKA_BROKERS, database: `${env.DATABASE_HOST}:${String(env.DATABASE_PORT)}` },
  'stream-processor: разбор кадров, запись телеметрии, здоровье приборов',
);
log.info(
  {
    consumes: [TOPICS.telemetryRaw.name, TOPICS.pollCycles.name],
    produces: [
      TOPICS.telemetryReadings.name,
      TOPICS.deviceState.name,
      TOPICS.alarmEvents.name,
      TOPICS.telemetryRawDlq.name,
    ],
  },
  'читает сырые кадры и циклы, пишет показания, алармы, состояние и очередь недоставленных',
);
log.info({ port: env.PROCESSOR_HTTP_PORT }, 'GET /health/live, /health/ready, /metrics');

process.once('beforeExit', () => {
  void pool.end();
});
