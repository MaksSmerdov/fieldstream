import type { FastifyBaseLogger } from 'fastify';

/** Логгер сервиса: тот же pino, что у HTTP-сервера, только нужные уровни. */
export type Logger = Pick<FastifyBaseLogger, 'debug' | 'info' | 'warn' | 'error'>;
