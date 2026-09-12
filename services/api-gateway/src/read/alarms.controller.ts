import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type pg from 'pg';
import { alarmsQuerySchema } from '@fieldstream/contracts';
import type { AlarmListItem, AlarmsResponse } from '@fieldstream/contracts';
import { ackAlarm, listAlarms } from '@fieldstream/db';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import { CurrentUser, RequirePermission } from '../auth/auth.guard.js';
import type { AccessClaims } from '../auth/tokens.js';
import { withClient } from '../common/with-client.js';
import { CLOCK, POOL } from '../tokens.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('alarms')
export class AlarmsController {
  public constructor(
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Лента алармов. Состояние эпизода это вопрос к времени снятия, отдельной колонки нет. */
  @Get()
  @RequirePermission('alarms')
  public async list(@Query() query: unknown): Promise<AlarmsResponse> {
    const parsed = alarmsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message));
    }

    const page = await withClient(this.pool, (client) => listAlarms(client, parsed.data)).catch(
      (error: unknown) => {
        if (error instanceof Error && error.message === 'курсор испорчен') {
          throw new BadRequestException('курсор испорчен');
        }
        throw error;
      },
    );

    return {
      items: page.items,
      nextCursor: page.nextCursor,
      serverTime: toIsoTimestamp(this.clock.now()),
    };
  }

  /** Подтверждение аларма. Первый подтвердивший остаётся в записи, повтор её не переписывает. */
  @Post(':id/ack')
  @RequirePermission('alarms.ack')
  public async ack(
    @Param('id') id: string,
    @Body() _body: unknown,
    @CurrentUser() claims: AccessClaims,
  ): Promise<AlarmListItem> {
    if (!UUID.test(id)) throw new BadRequestException('идентификатор аларма это uuid');

    const alarm = await withClient(this.pool, (client) =>
      ackAlarm(client, id, claims.email, toIsoTimestamp(this.clock.now())),
    );
    if (alarm === null) throw new NotFoundException(`аларма ${id} нет`);

    return alarm;
  }
}
