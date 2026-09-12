import { Controller, Query, Req, Sse } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { liveSubscriptionKeySchema } from '@fieldstream/contracts';
import type { LiveSubscriptionKey } from '@fieldstream/contracts';
import { CurrentUser } from '../auth/auth.guard.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import type { AccessClaims } from '../auth/tokens.js';
import { LiveBusService } from './live-bus.service.js';

/** Ключи подписки из строки запроса. Непонятные молча отбрасываются: подписка не повод для отказа. */
const keysOf = (raw: string | undefined): Set<LiveSubscriptionKey> | null => {
  const keys = (raw ?? '')
    .split(',')
    .map((key) => key.trim())
    .flatMap((key) => {
      const parsed = liveSubscriptionKeySchema.safeParse(key);
      return parsed.success ? [parsed.data] : [];
    });

  return keys.length === 0 ? null : new Set(keys);
};

/** Живой канал: одно соединение на вкладку, события приходят потоком, а не опросом. */
@Controller('events')
export class EventsController {
  public constructor(private readonly bus: LiveBusService) {}

  @Sse()
  public stream(
    @Req() request: AuthenticatedRequest,
    @Query('keys') keys: string | undefined,
    @CurrentUser() claims: AccessClaims,
  ): Observable<MessageEvent> {
    const header = request.headers['last-event-id'];

    return this.bus.stream({
      lastEventId: typeof header === 'string' && header.length > 0 ? header : null,
      permissions: claims.permissions,
      keys: keysOf(keys),
    });
  }
}
