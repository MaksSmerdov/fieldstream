import 'reflect-metadata';
import { hostname } from 'node:os';
import pg from 'pg';
import { ROLES, connectionUrl } from '@fieldstream/db';
import { SystemClock } from '@fieldstream/domain';
import { createLogger } from '@fieldstream/nest-common';
import { createApp } from './bootstrap.js';
import { loadEnv } from './config/env.js';
import { createMetrics } from './metrics/metrics.js';

const env = loadEnv(process.env);
const log = createLogger('api-gateway', env.LOG_LEVEL);
const metrics = createMetrics();
const instanceId = env.GATEWAY_INSTANCE_ID ?? `${hostname()}-${String(process.pid)}`;
const pool = new pg.Pool({
  connectionString: connectionUrl(
    { host: env.DATABASE_HOST, port: env.DATABASE_PORT, database: env.POSTGRES_DB },
    ROLES.api,
    env.FS_API_PASSWORD,
  ),
  max: 8,
});
pool.on('error', (error) => {
  log.warn({ err: error }, 'соединение пула базы оборвалось');
});

const app = await createApp({ env, log, clock: SystemClock, metrics, pool, instanceId });
await app.listen(env.GATEWAY_HTTP_PORT, env.GATEWAY_HOST);

log.info(
  {
    instanceId,
    database: `${env.DATABASE_HOST}:${String(env.DATABASE_PORT)}`,
    origins: env.CORS_ORIGINS,
  },
  'api-gateway: чтение истории, алармы, живой канал',
);
log.info({ port: env.GATEWAY_HTTP_PORT }, 'GET /health/live, /health/ready, /metrics, /api/events');

process.once('beforeExit', () => {
  void pool.end();
});
