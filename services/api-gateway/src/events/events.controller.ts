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

  /**
   * Позиция возобновления берётся из заголовка, а при его отсутствии из строки запроса:
   * браузер ставит заголовок сам только при своём автореконнекте, а при переоткрытии
   * по сторожу тишины поставить его нечем.
   */
  @Sse()
  public stream(
    @Req() request: AuthenticatedRequest,
    @Query('keys') keys: string | undefined,
    @Query('last_event_id') lastEventId: string | undefined,
    @CurrentUser() claims: AccessClaims,
  ): Observable<MessageEvent> {
    const header = request.headers['last-event-id'];
    const fromHeader = typeof header === 'string' && header.length > 0 ? header : null;
    const fromQuery = lastEventId !== undefined && lastEventId.length > 0 ? lastEventId : null;

    return this.bus.stream({
      lastEventId: fromHeader ?? fromQuery,
      permissions: claims.permissions,
      keys: keysOf(keys),
    });
  }
}
