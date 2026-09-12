import { Controller, Query, Req, Sse } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { CurrentUser } from '../auth/auth.guard.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import type { AccessClaims } from '../auth/tokens.js';
import { LiveBusService } from './live-bus.service.js';

/** Живой канал: одно соединение на вкладку, события приходят потоком, а не опросом. */
@Controller('events')
export class EventsController {
  public constructor(private readonly bus: LiveBusService) {}

  @Sse()
  public stream(
    @Req() request: AuthenticatedRequest,
    @Query('devices') devices: string | undefined,
    @CurrentUser() claims: AccessClaims,
  ): Observable<MessageEvent> {
    const header = request.headers['last-event-id'];
    const codes = (devices ?? '')
      .split(',')
      .map((code) => code.trim())
      .filter((code) => code.length > 0);

    return this.bus.stream({
      lastEventId: typeof header === 'string' && header.length > 0 ? header : null,
      permissions: claims.permissions,
      devices: codes.length === 0 ? null : new Set(codes),
    });
  }
}
