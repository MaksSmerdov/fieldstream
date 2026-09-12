import {
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import type { CanActivate, CustomDecorator, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { hasPermission } from '@fieldstream/contracts';
import type { ModuleId } from '@fieldstream/contracts';
import { AuthService } from './auth.service.js';
import type { AccessClaims } from './tokens.js';

const PUBLIC = 'fieldstream:public';
const MODULE = 'fieldstream:module';

/** Маршрут без входа: вход, обновление пары, живость и метрики. */
export const Public = (): CustomDecorator => SetMetadata(PUBLIC, true);

/** Маршрут требует права на модуль. Имя модуля то же самое, что и на фронте. */
export const RequirePermission = (module: ModuleId): CustomDecorator => SetMetadata(MODULE, module);

/** Запрос с разобранным токеном доступа. */
export interface AuthenticatedRequest extends FastifyRequest {
  claims?: AccessClaims;
}

/** Пользователь текущего запроса в аргументе обработчика. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AccessClaims => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.claims === undefined) throw new UnauthorizedException('нет токена доступа');
    return request.claims;
  },
);

/** Токен из заголовка, а для живого канала из строки запроса: EventSource заголовки не умеет. */
const tokenOf = (request: AuthenticatedRequest): string | null => {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);

  const query: unknown = request.query;
  if (typeof query === 'object' && query !== null && 'access_token' in query) {
    const value = (query as Record<string, unknown>)['access_token'];
    if (typeof value === 'string' && value.length > 0) return value;
  }

  return null;
};

@Injectable()
export class AuthGuard implements CanActivate {
  public constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC, targets) === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = tokenOf(request);
    if (token === null) throw new UnauthorizedException('нет токена доступа');

    const claims = await this.auth.claimsOf(token);
    if (claims === null) throw new UnauthorizedException('токен доступа недействителен');
    request.claims = claims;

    const required = this.reflector.getAllAndOverride<ModuleId | undefined>(MODULE, targets);
    if (required !== undefined && !hasPermission(claims.permissions, required)) {
      throw new ForbiddenException(`нет права на модуль ${required}`);
    }

    return true;
  }
}
