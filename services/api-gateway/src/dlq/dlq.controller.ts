import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type pg from 'pg';
import { dlqIdSchema, dlqListQuerySchema, dlqRedriveRequestSchema } from '@fieldstream/contracts';
import type { DlqListResponse, DlqRedrive } from '@fieldstream/contracts';
import { enqueueDlqRedrive, listDlqMessages, loadDlqRedrive } from '@fieldstream/db';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import type { Logger } from '@fieldstream/nest-common';
import { CurrentUser, RequirePermission } from '../auth/auth.guard.js';
import type { AccessClaims } from '../auth/tokens.js';
import { withClient } from '../common/with-client.js';
import { CLOCK, LOGGER, POOL } from '../tokens.js';

@Controller('dlq')
export class DlqController {
  public constructor(
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  /** Очередь недоставленных от новых к старым, страницами по курсору. */
  @Get()
  @RequirePermission('pipeline')
  public async list(@Query() query: unknown): Promise<DlqListResponse> {
    const parsed = dlqListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message));
    }

    const page = await withClient(this.pool, (client) => listDlqMessages(client, parsed.data));

    return {
      serverTime: toIsoTimestamp(this.clock.now()),
      items: page.items,
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Запрос повторной подачи. В брокер шлюз не пишет: запрос ложится в базу, выполняет его
   * процессор, а интерфейс следит за ним по номеру.
   */
  @Post('redrive')
  @HttpCode(202)
  @RequirePermission('pipeline.control')
  public async redrive(
    @Body() body: unknown,
    @CurrentUser() claims: AccessClaims,
  ): Promise<DlqRedrive> {
    const parsed = dlqRedriveRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message));
    }

    const request = await withClient(this.pool, (client) =>
      enqueueDlqRedrive(client, { requestedBy: claims.email, maxMessages: parsed.data.max }),
    );
    this.log.info(
      { user: claims.email, redriveId: request.id, maxMessages: request.maxMessages },
      'запрошена повторная подача из очереди недоставленных',
    );

    return request;
  }

  /** Судьба запроса повторной подачи: ждёт процессор, выполняется или завершён со счётами. */
  @Get('redrive/:id')
  @RequirePermission('pipeline')
  public async progress(@Param('id') id: string): Promise<DlqRedrive> {
    if (!dlqIdSchema.safeParse(id).success) {
      throw new BadRequestException('номер запроса это целое положительное число');
    }

    const request = await withClient(this.pool, (client) => loadDlqRedrive(client, id));
    if (request === null) throw new NotFoundException(`запроса повторной подачи ${id} нет`);

    return request;
  }
}
