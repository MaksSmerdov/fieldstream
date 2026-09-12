import type { FastifyInstance } from 'fastify';
import type { Clock } from '@fieldstream/domain';
import { toIsoTimestamp } from '@fieldstream/domain';

/** Имя заголовка с серверным временем: по нему фронт правит свои часы. */
export const SERVER_TIME_HEADER = 'x-server-time';

/**
 * Серверное время ставится хуком на входе, а не интерсептором: живой канал пишет прямо
 * в сокет и снимает заголовки один раз, ещё до того как отработает цепочка интерсепторов.
 */
export const registerServerTime = (fastify: FastifyInstance, clock: Clock): void => {
  fastify.addHook('onRequest', (request, reply, done) => {
    reply.header(SERVER_TIME_HEADER, toIsoTimestamp(clock.now()));
    done();
  });
};
