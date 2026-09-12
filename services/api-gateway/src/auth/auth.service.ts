import { randomUUID } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type pg from 'pg';
import { getEffectivePermissions } from '@fieldstream/contracts';
import type { LoginRequest, SessionResponse, SessionUser } from '@fieldstream/contracts';
import {
  consumeRateLimit,
  createSession,
  findRotatedFrom,
  loadUserById,
  loadUserByEmail,
  revokeSessionById,
  revokeSessionByToken,
  rotateSession,
} from '@fieldstream/db';
import type { UserRecord } from '@fieldstream/db';
import { toIsoTimestamp, verifyPassword } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import type { Logger } from '@fieldstream/nest-common';
import type { Env } from '../config/env.js';
import { CLOCK, ENV, LOGGER, POOL } from '../tokens.js';
import {
  deriveKeys,
  issueAccessToken,
  newRefreshToken,
  refreshTokenHash,
  verifyAccessToken,
} from './tokens.js';
import type { AccessClaims, AuthKeys } from './tokens.js';

/** Откуда пришёл запрос: нужно и ограничителю попыток, и строке сессии. */
export interface RequestOrigin {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** Выданная пара: тело ответа и отдельно токен обновления, который уходит только в cookie. */
export interface IssuedSession {
  readonly response: SessionResponse;
  readonly refreshToken: string;
  readonly refreshExpiresAtMs: number;
}

interface RecentRotation {
  readonly issued: IssuedSession;
  readonly untilMs: number;
}

/** Пользователь для интерфейса: права считает одна функция из роли и личных прав. */
const toSessionUser = (user: UserRecord): SessionUser => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  role: user.role,
  permissions: getEffectivePermissions(user.role, user.grants, user.denies),
});

@Injectable()
export class AuthService {
  private readonly keys: AuthKeys;
  private readonly recent = new Map<string, RecentRotation>();
  private readonly rotating = new Map<string, Promise<IssuedSession>>();

  public constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(LOGGER) private readonly log: Logger,
  ) {
    this.keys = deriveKeys(env.AUTH_SECRET);
  }

  /** Разбор токена доступа для guard. */
  public async claimsOf(token: string): Promise<AccessClaims | null> {
    return verifyAccessToken(this.keys, token, this.clock.now());
  }

  /**
   * Вход по паролю. Частота попыток ограничена по почте и по адресу: подбор упирается
   * в ведро на таблице, которое переживает перезапуск шлюза.
   */
  public async login(request: LoginRequest, origin: RequestOrigin): Promise<IssuedSession> {
    const buckets: readonly [string, number][] = [
      [`login:email:${request.email.toLowerCase()}`, this.env.LOGIN_ATTEMPTS],
      ...(origin.ip === null
        ? []
        : ([[`login:ip:${origin.ip}`, this.env.LOGIN_IP_ATTEMPTS]] as [string, number][])),
    ];
    for (const [bucket, capacity] of buckets) await this.rate(bucket, capacity, 0);

    const user = await this.withClient((client) => loadUserByEmail(client, request.email));
    const matches =
      user === null ? false : await verifyPassword(request.password, user.passwordHash);
    if (user === null || user.disabled || !matches) {
      for (const [bucket, capacity] of buckets) await this.rate(bucket, capacity, 1);
      throw new UnauthorizedException('неверная почта или пароль');
    }

    return this.issue(user, randomUUID(), origin);
  }

  /**
   * Обновление пары. Ротация атомарна, поэтому из двух одновременных запросов строку получает
   * ровно один. Проигравший берёт ту же пару из окна повтора: потерянный по дороге ответ это
   * не повод закрывать сессию. Старый токен, предъявленный вне окна, считается утечкой.
   */
  public async refresh(token: string | undefined, origin: RequestOrigin): Promise<IssuedSession> {
    if (token === undefined || token.length === 0) {
      throw new UnauthorizedException('нет токена обновления');
    }

    const nowMs = this.clock.now();
    const previousHash = refreshTokenHash(this.keys, token);
    const repeated = this.takeRecent(previousHash, nowMs);
    if (repeated !== null) return repeated;

    const running = this.rotating.get(previousHash);
    if (running !== undefined) return running;

    const rotation = this.rotate(previousHash, nowMs, origin).finally(() => {
      this.rotating.delete(previousHash);
    });
    this.rotating.set(previousHash, rotation);

    return rotation;
  }

  /** Сама ротация. Вынесена отдельно, чтобы две одновременные попытки делили один результат. */
  private async rotate(
    previousHash: string,
    nowMs: number,
    origin: RequestOrigin,
  ): Promise<IssuedSession> {
    const nextToken = newRefreshToken();
    const refreshExpiresAtMs = nowMs + this.env.REFRESH_TTL_MS;
    const rotated = await this.withClient((client) =>
      rotateSession(
        client,
        previousHash,
        refreshTokenHash(this.keys, nextToken),
        toIsoTimestamp(refreshExpiresAtMs),
      ),
    );

    if (rotated === null) {
      const reused = await this.withClient((client) => findRotatedFrom(client, previousHash));
      if (reused !== null) {
        await this.withClient((client) => revokeSessionById(client, reused.id));
        this.log.warn(
          { sessionId: reused.sessionId, ip: origin.ip },
          'токен обновления предъявлен повторно вне окна: сессия закрыта',
        );
      }
      throw new UnauthorizedException('сессия недействительна, войдите заново');
    }

    const user = await this.withClient((client) => loadUserById(client, rotated.userId));
    if (user === null || user.disabled) {
      await this.withClient((client) => revokeSessionById(client, rotated.id));
      throw new UnauthorizedException('учётная запись отключена');
    }

    const issued = await this.issueFor(user, rotated.sessionId, nextToken, refreshExpiresAtMs);
    this.recent.set(previousHash, {
      issued,
      untilMs: nowMs + this.env.REFRESH_REUSE_WINDOW_MS,
    });
    return issued;
  }

  public async logout(token: string | undefined): Promise<void> {
    if (token === undefined || token.length === 0) return;

    const hash = refreshTokenHash(this.keys, token);
    this.recent.delete(hash);
    await this.withClient((client) => revokeSessionByToken(client, hash));
  }

  /** Пользователь с правами из базы: они могли измениться после выдачи токена. */
  public async userOf(userId: string): Promise<SessionUser | null> {
    const user = await this.withClient((client) => loadUserById(client, userId));
    return user === null || user.disabled ? null : toSessionUser(user);
  }

  private async issue(
    user: UserRecord,
    sessionId: string,
    origin: RequestOrigin,
  ): Promise<IssuedSession> {
    const refreshToken = newRefreshToken();
    const refreshExpiresAtMs = this.clock.now() + this.env.REFRESH_TTL_MS;

    await this.withClient((client) =>
      createSession(client, {
        userId: user.id,
        sessionId,
        tokenHash: refreshTokenHash(this.keys, refreshToken),
        expiresAt: toIsoTimestamp(refreshExpiresAtMs),
        userAgent: origin.userAgent,
        ip: origin.ip,
      }),
    );

    return this.issueFor(user, sessionId, refreshToken, refreshExpiresAtMs);
  }

  private async issueFor(
    user: UserRecord,
    sessionId: string,
    refreshToken: string,
    refreshExpiresAtMs: number,
  ): Promise<IssuedSession> {
    const sessionUser = toSessionUser(user);
    const access = await issueAccessToken(
      this.keys,
      {
        userId: user.id,
        email: user.email,
        sessionId,
        role: user.role,
        permissions: sessionUser.permissions,
      },
      this.clock.now(),
      this.env.ACCESS_TTL_MS,
    );

    return {
      response: {
        accessToken: access.token,
        expiresAt: toIsoTimestamp(access.expiresAtMs),
        user: sessionUser,
      },
      refreshToken,
      refreshExpiresAtMs,
    };
  }

  /** Окно повтора: ответ мог не дойти до вкладки, и тот же токен придёт ещё раз. */
  private takeRecent(previousHash: string, nowMs: number): IssuedSession | null {
    for (const [key, value] of this.recent) {
      if (value.untilMs <= nowMs) this.recent.delete(key);
    }

    return this.recent.get(previousHash)?.issued ?? null;
  }

  /** Цена ноль это проверка «можно ли ещё пробовать», цена единица это отметка неудачи. */
  private async rate(bucketKey: string, capacity: number, cost: number): Promise<void> {
    const client = await this.pool.connect().catch((error: unknown) => {
      throw new ServiceUnavailableException(describe(error));
    });

    try {
      const decision = await consumeRateLimit(
        client,
        bucketKey,
        this.clock.now(),
        { capacity, refillMs: this.env.LOGIN_REFILL_MS },
        cost,
      );
      if (!decision.allowed) {
        throw new HttpException(
          {
            message: 'слишком много попыток входа, подождите',
            retryAfterMs: decision.retryAfterMs,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(describe(error));
    } finally {
      client.release();
    }
  }

  /**
   * Работа с базой под одним соединением. Сбой базы это 503, а не 401: недоступное
   * хранилище не должно выглядеть как отозванная сессия и разлогинивать вкладку.
   */
  private async withClient<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect().catch((error: unknown) => {
      throw new ServiceUnavailableException(describe(error));
    });

    try {
      return await work(client);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(describe(error));
    } finally {
      client.release();
    }
  }
}

/** Текст ошибки для ответа: наружу уходит причина недоступности, но не устройство базы. */
const describe = (error: unknown): string =>
  `хранилище сессий недоступно: ${error instanceof Error ? error.message : String(error)}`;
