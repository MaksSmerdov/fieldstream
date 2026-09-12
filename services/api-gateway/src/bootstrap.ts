import fastifyCookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { NestPinoLogger } from '@fieldstream/nest-common';
import { AppModule } from './app.module.js';
import type { AppDeps } from './app.module.js';
import { SERVER_TIME_HEADER, registerServerTime } from './common/server-time.js';

/** Маршруты обслуживания живут вне префикса: их зовут healthcheck контейнера и сборщик метрик. */
const UNPREFIXED = ['health/live', 'health/ready', 'metrics'];

/** Собранное приложение без запуска: точка входа и тесты поднимают одно и то же. */
export const createApp = async (deps: AppDeps): Promise<NestFastifyApplication> => {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(deps),
    new FastifyAdapter({ trustProxy: deps.env.TRUST_PROXY }),
    { logger: new NestPinoLogger(deps.log) },
  );

  await app.register(fastifyCookie);

  const fastify = app.getHttpAdapter().getInstance();
  registerServerTime(fastify, deps.clock);
  fastify.addHook('onResponse', (request, reply, done) => {
    deps.metrics.observeRequest(
      request.routeOptions.url ?? request.url,
      reply.statusCode,
      reply.elapsedTime,
    );
    done();
  });

  app.setGlobalPrefix('api', { exclude: UNPREFIXED });
  app.enableCors({
    origin: deps.env.CORS_ORIGINS,
    credentials: true,
    exposedHeaders: [SERVER_TIME_HEADER],
  });
  app.enableShutdownHooks();

  return app;
};
