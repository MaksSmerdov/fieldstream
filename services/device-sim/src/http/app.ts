import { LogController, fastify } from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyServerOptions } from 'fastify';
import type { ZodError } from 'zod';
import {
  simClearFaultsQuerySchema,
  simFaultRequestSchema,
  simScenarioNameSchema,
  simSpeedRequestSchema,
} from '@fieldstream/contracts';
import type { SimClearFaultsResult } from '@fieldstream/contracts';
import type { FaultResult, Simulator } from '../simulator.js';

interface ProblemIssue {
  readonly path: string;
  readonly message: string;
}

interface Problem {
  readonly type: 'about:blank';
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly issues?: readonly ProblemIssue[];
}

/** Ставит код ответа и возвращает тело: обработчики остаются синхронными. */
const withStatus = <T>(reply: FastifyReply, status: number, body: T): T => {
  void reply.code(status);
  return body;
};

/** Ошибка в формате problem+json (RFC 9457). */
const problem = (
  reply: FastifyReply,
  status: number,
  title: string,
  detail: string,
  issues: readonly ProblemIssue[] = [],
): Problem => {
  void reply.code(status).type('application/problem+json');
  return issues.length > 0
    ? { type: 'about:blank', title, status, detail, issues }
    : { type: 'about:blank', title, status, detail };
};

const issuesOf = (error: ZodError): ProblemIssue[] =>
  error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));

/** Тело ответа на внесение поломки. */
const faultResponse = (reply: FastifyReply, result: FaultResult): unknown => {
  switch (result.outcome) {
    case 'fault':
      return withStatus(reply, 201, result.fault);
    case 'action':
      return withStatus(reply, 202, { action: result.action, deviceCode: result.deviceCode });
    case 'rejected':
      return problem(
        reply,
        result.status,
        result.status === 404 ? 'Цель не найдена' : 'Поломка неприменима',
        result.message,
      );
  }
};

/** Управляющий API стенда. Про Kafka стенд не знает: у команды ровно один получатель. */
export const buildHttpApp = (
  sim: Simulator,
  logger: NonNullable<FastifyServerOptions['logger']>,
): FastifyInstance => {
  const app = fastify({
    logger,
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.get('/health', () => ({ status: 'ok' }));

  app.get('/sim/state', () => sim.state());

  app.post('/sim/fault', (request, reply) => {
    const parsed = simFaultRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return problem(
        reply,
        400,
        'Неверный запрос',
        'описание поломки не прошло проверку',
        issuesOf(parsed.error),
      );
    }

    const result = sim.applyFault(parsed.data);
    if (result.outcome !== 'rejected') app.log.info({ fault: parsed.data }, 'поломка внесена');
    return faultResponse(reply, result);
  });

  app.delete('/sim/faults', (request, reply) => {
    const parsed = simClearFaultsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return problem(
        reply,
        400,
        'Неверный запрос',
        'фильтр снятия поломок не прошёл проверку',
        issuesOf(parsed.error),
      );
    }

    const removed = sim.clearFaults(parsed.data);
    app.log.info({ removed, filter: parsed.data }, 'поломки сняты');
    const result: SimClearFaultsResult = { removed };
    return result;
  });

  app.post<{ Params: { name: string } }>('/sim/scenario/:name', (request, reply) => {
    const name = simScenarioNameSchema.safeParse(request.params.name);
    if (!name.success) {
      return problem(
        reply,
        404,
        'Сценарий не найден',
        `сценария "${request.params.name}" нет, есть: ${simScenarioNameSchema.options.join(', ')}`,
      );
    }

    const results = sim.runScenario(name.data);
    app.log.info({ scenario: name.data }, 'сценарий запущен');
    return withStatus(reply, 202, { scenario: name.data, results });
  });

  app.post('/sim/speed', (request, reply) => {
    const parsed = simSpeedRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return problem(
        reply,
        400,
        'Неверный запрос',
        'ускорение задаётся числом от 1 до 60',
        issuesOf(parsed.error),
      );
    }

    sim.setSpeed(parsed.data.factor);
    app.log.info({ speed: parsed.data.factor }, 'ускорение стенда изменено');
    return { speed: parsed.data.factor };
  });

  return app;
};
