import { randomBytes, randomUUID } from 'node:crypto';
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
} from '@nestjs/common';
import type pg from 'pg';
import { TOPICS, commandRequestSchema, deviceCommandSchema } from '@fieldstream/contracts';
import type {
  CommandAccepted,
  CommandProgressResponse,
  DeviceCommand,
} from '@fieldstream/contracts';
import { enqueueOutbox, loadCommandProgress, loadLineSite } from '@fieldstream/db';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import { CurrentUser, RequirePermission } from '../auth/auth.guard.js';
import type { AccessClaims } from '../auth/tokens.js';
import { withClient } from '../common/with-client.js';
import type { Env } from '../config/env.js';
import { OutboxRelayService } from './outbox-relay.service.js';
import { CLOCK, ENV, POOL } from '../tokens.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('commands')
export class CommandsController {
  public constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly relay: OutboxRelayService,
  ) {}

  /**
   * Приём команды. Команда не уходит в брокер прямо здесь: она ложится в очередь исходящих
   * той же транзакцией, что и её приём. Откат транзакции не оставляет сообщения в топике,
   * а отправку делает фоновая рассылка, которая переживёт и недоступный брокер.
   * Собранная команда проверяется своей схемой: аргументы, обязательные для конкретного вида,
   * ловятся здесь, а не у исполнителя, которому отказывать уже поздно.
   */
  @Post()
  @HttpCode(202)
  @RequirePermission('commands.send')
  public async issue(
    @Body() body: unknown,
    @CurrentUser() claims: AccessClaims,
  ): Promise<CommandAccepted> {
    const parsed = commandRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message));
    }

    const siteCode = await withClient(this.pool, (client) =>
      loadLineSite(client, parsed.data.lineCode),
    );
    if (siteCode === null)
      throw new NotFoundException(`линии ${parsed.data.lineCode} нет на стенде`);

    const nowMs = this.clock.now();
    const draft: DeviceCommand = {
      schema: 'device.command',
      v: 1,
      commandId: randomUUID(),
      issuedBy: claims.email,
      siteCode,
      lineCode: parsed.data.lineCode,
      kind: parsed.data.kind,
      args: parsed.data.args,
      issuedAt: toIsoTimestamp(nowMs),
      expiresAt: toIsoTimestamp(nowMs + this.env.COMMAND_TTL_MS),
      traceId: randomBytes(8).toString('hex'),
    };

    const checked = deviceCommandSchema.safeParse(draft);
    if (!checked.success) {
      throw new BadRequestException(checked.error.issues.map((issue) => issue.message));
    }
    const command = checked.data;

    await withClient(this.pool, (client) =>
      enqueueOutbox(client, {
        aggregateType: 'command',
        aggregateId: command.commandId,
        revision: 1,
        topic: TOPICS.deviceCommands.name,
        msgKey: command.siteCode,
        payload: command,
      }),
    );
    void this.relay.tick();

    return {
      commandId: command.commandId,
      lineCode: command.lineCode,
      kind: command.kind,
      issuedAt: command.issuedAt,
      expiresAt: command.expiresAt,
    };
  }

  /** Судьба команды: ждёт отправки, ушла в топик или применена исполнителем. */
  @Get(':commandId')
  @RequirePermission('commands.send')
  public async progress(@Param('commandId') commandId: string): Promise<CommandProgressResponse> {
    if (!UUID.test(commandId)) throw new BadRequestException('идентификатор команды это uuid');

    const progress = await withClient(this.pool, (client) =>
      loadCommandProgress(client, commandId),
    );
    if (progress === null) throw new NotFoundException(`команды ${commandId} нет`);

    return progress;
  }
}
