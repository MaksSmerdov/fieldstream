import { Controller, Get, Inject, UnauthorizedException } from '@nestjs/common';
import type { MeResponse } from '@fieldstream/contracts';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import { CLOCK } from '../tokens.js';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './auth.guard.js';
import type { AccessClaims } from './tokens.js';

/** Кто я и что мне можно. Права читаются из базы: они могли измениться после выдачи токена. */
@Controller('me')
export class MeController {
  public constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly auth: AuthService,
  ) {}

  @Get()
  public async me(@CurrentUser() claims: AccessClaims): Promise<MeResponse> {
    const user = await this.auth.userOf(claims.userId);
    if (user === null) throw new UnauthorizedException('учётная запись недоступна');

    return { user, serverTime: toIsoTimestamp(this.clock.now()) };
  }
}
