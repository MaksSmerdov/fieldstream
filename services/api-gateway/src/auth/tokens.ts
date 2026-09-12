import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { ModuleId, Role } from '@fieldstream/contracts';

/** Разбор токена доступа: тому, кто пришёл с ним, больше ничего доказывать не нужно. */
export interface AccessClaims {
  readonly userId: string;
  readonly email: string;
  readonly sessionId: string;
  readonly role: Role;
  readonly permissions: readonly ModuleId[];
}

export interface AuthKeys {
  readonly accessKey: Uint8Array;
  readonly pepper: string;
}

/** Два разных ключа из одного секрета: подпись токена доступа и перец хеша токена обновления. */
export const deriveKeys = (secret: string): AuthKeys => ({
  accessKey: createHmac('sha256', secret).update('fieldstream:access').digest(),
  pepper: createHmac('sha256', secret).update('fieldstream:refresh').digest('hex'),
});

export interface IssuedAccess {
  readonly token: string;
  readonly expiresAtMs: number;
}

/** Токен доступа живёт в памяти вкладки: короткий срок и никакого хранения на сервере. */
export const issueAccessToken = async (
  keys: AuthKeys,
  claims: AccessClaims,
  nowMs: number,
  ttlMs: number,
): Promise<IssuedAccess> => {
  const expiresAtMs = nowMs + ttlMs;
  const token = await new SignJWT({
    email: claims.email,
    role: claims.role,
    permissions: [...claims.permissions],
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setJti(claims.sessionId)
    .setIssuedAt(Math.floor(nowMs / 1000))
    .setExpirationTime(Math.floor(expiresAtMs / 1000))
    .sign(keys.accessKey);

  return { token, expiresAtMs };
};

/** Проверка токена доступа. Просроченный или подделанный токен это null, а не исключение. */
export const verifyAccessToken = async (
  keys: AuthKeys,
  token: string,
  nowMs: number,
): Promise<AccessClaims | null> => {
  try {
    const { payload } = await jwtVerify(token, keys.accessKey, {
      algorithms: ['HS256'],
      currentDate: new Date(nowMs),
    });
    const role = payload['role'];
    const email = payload['email'];
    const permissions = payload['permissions'];
    if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string') return null;
    if (typeof role !== 'string' || typeof email !== 'string') return null;
    if (!Array.isArray(permissions)) return null;

    return {
      userId: payload.sub,
      email,
      sessionId: payload.jti,
      role: role as Role,
      permissions: permissions.filter((item): item is ModuleId => typeof item === 'string'),
    };
  } catch {
    return null;
  }
};

/** Токен обновления это просто случайные байты: смысл ему придаёт только строка в базе. */
export const newRefreshToken = (): string => randomBytes(32).toString('base64url');

/** В базе лежит хеш с перцем: утечка таблицы сессий не даёт войти ни в одну из них. */
export const refreshTokenHash = (keys: AuthKeys, token: string): string =>
  createHash('sha256').update(`${keys.pepper}:${token}`).digest('hex');

/** Сравнение токенов постоянного времени: длина заранее известна, утечки по времени нет. */
export const sameToken = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
