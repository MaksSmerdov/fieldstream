import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { HttpException } from '@nestjs/common';
import { z } from 'zod';
import { simClearFaultsResultSchema, simFaultSchema, simStateSchema } from '@fieldstream/contracts';
import type {
  LabFaultRequest,
  SimClearFaultsQuery,
  SimClearFaultsResult,
  SimFault,
  SimState,
} from '@fieldstream/contracts';
import type { Logger } from '@fieldstream/nest-common';
import type { Env } from '../config/env.js';
import { ENV, LOGGER } from '../tokens.js';

const TIMEOUT_MS = 3_000;

const problemSchema = z.object({ status: z.number().int(), detail: z.string().min(1) });

const PASSED_THROUGH = new Map<number, (detail: string) => HttpException>([
  [400, (detail) => new BadRequestException(detail)],
  [404, (detail) => new NotFoundException(detail)],
  [422, (detail) => new UnprocessableEntityException(detail)],
]);

interface SimReply {
  readonly status: number;
  readonly problem: boolean;
  readonly body: unknown;
}

/** Тело ответа как JSON, а не JSON превращается в null. */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

/** Клиент управляющего API стенда. Ответы разбираются схемами контрактов. */
@Injectable()
export class SimClientService {
  public constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  public async state(): Promise<SimState> {
    return this.expect(await this.call('GET', '/sim/state'), 200, simStateSchema);
  }

  public async injectFault(request: LabFaultRequest): Promise<SimFault> {
    return this.expect(await this.call('POST', '/sim/fault', request), 201, simFaultSchema);
  }

  public async clearFaults(query: SimClearFaultsQuery): Promise<SimClearFaultsResult> {
    const params = new URLSearchParams();
    if (query.targetId !== undefined) params.set('targetId', query.targetId);
    if (query.kind !== undefined) params.set('kind', query.kind);
    const search = params.toString();

    return this.expect(
      await this.call('DELETE', search.length > 0 ? `/sim/faults?${search}` : '/sim/faults'),
      200,
      simClearFaultsResultSchema,
    );
  }

  /** Запрос к стенду. Не заданный адрес, обрыв сети и таймаут превращаются в 503. */
  private async call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<SimReply> {
    const base = this.env.SIM_URL;
    if (base === undefined) throw new ServiceUnavailableException('симулятор не подключён к шлюзу');

    try {
      const response = await fetch(new URL(path, base), {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await response.text();

      return {
        status: response.status,
        problem: (response.headers.get('content-type') ?? '').includes('application/problem+json'),
        body: parseJson(text),
      };
    } catch (error) {
      this.log.warn({ err: error, method, path }, 'симулятор не ответил');
      throw new ServiceUnavailableException('симулятор недоступен');
    }
  }

  /** Ожидаемый ответ по схеме. Известный отказ стенда проходит тем же кодом, прочее это 502. */
  private expect<T>(
    reply: SimReply,
    status: number,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): T {
    if (reply.status === status) {
      const parsed = schema.safeParse(reply.body);
      if (parsed.success) return parsed.data;
    }

    const passThrough = PASSED_THROUGH.get(reply.status);
    const problem = problemSchema.safeParse(reply.body);
    if (passThrough !== undefined && reply.problem && problem.success) {
      throw passThrough(problem.data.detail);
    }

    this.log.warn({ status: reply.status }, 'симулятор ответил неожиданно');
    throw new BadGatewayException('симулятор ответил неожиданно');
  }
}
