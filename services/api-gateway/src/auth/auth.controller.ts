import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { loginRequestSchema } from '@fieldstream/contracts';
import type { SessionResponse } from '@fieldstream/contracts';
import type { Env } from '../config/env.js';
import { ENV } from '../tokens.js';
import { AuthService } from './auth.service.js';
import type { IssuedSession, RequestOrigin } from './auth.service.js';
import { Public } from './auth.guard.js';
import type { AuthenticatedRequest } from './auth.guard.js';

/** Токен обновления живёт только в cookie с узким путём: из JavaScript его не достать. */
const REFRESH_COOKIE = 'fs_refresh';
const REFRESH_PATH = '/api/auth';

const originOf = (request: AuthenticatedRequest): RequestOrigin => ({
  ip: request.ip.length > 0 ? request.ip : null,
  userAgent: request.headers['user-agent'] ?? null,
});

@Controller('auth')
export class AuthController {
  public constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly auth: AuthService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  public async login(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    const parsed = loginRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message));
    }

    return this.send(reply, await this.auth.login(parsed.data, originOf(request)));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  public async refresh(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    const token = request.cookies[REFRESH_COOKIE];

    return this.send(reply, await this.auth.refresh(token, originOf(request)));
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  public async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.auth.logout(request.cookies[REFRESH_COOKIE]);
    reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
  }

  private send(reply: FastifyReply, issued: IssuedSession): SessionResponse {
    reply.setCookie(REFRESH_COOKIE, issued.refreshToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.env.COOKIE_SECURE,
      path: REFRESH_PATH,
      expires: new Date(issued.refreshExpiresAtMs),
    });

    return issued.response;
  }
}
