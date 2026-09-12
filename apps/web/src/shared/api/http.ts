import { sessionResponseSchema } from '@fieldstream/contracts';
import { applyServerTime, startedAtMs } from '../time/serverClock.js';
import { useSessionStore } from '../auth/session-store.js';

/** Имя заголовка с серверным временем: по нему интерфейс подводит свои часы. */
const SERVER_TIME_HEADER = 'x-server-time';

/**
 * Ошибка запроса. Разделение «сессия отозвана» и «сервер недоступен» принципиально: в первом
 * случае человека надо отправить на вход, во втором показать ошибку и оставить его на месте.
 */
export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  public get isUnauthorized(): boolean {
    return this.status === 401;
  }

  public get isForbidden(): boolean {
    return this.status === 403;
  }

  /** Сервер недоступен или не успел ответить: данные не потеряны, повтор имеет смысл. */
  public get isUnavailable(): boolean {
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

interface ErrorBody {
  readonly message?: unknown;
  readonly error?: unknown;
}

/** Текст ошибки из ответа Nest: сообщением может быть и строка, и список причин. */
const messageOf = (body: unknown, status: number): string => {
  if (typeof body !== 'object' || body === null) return `запрос отклонён, код ${String(status)}`;
  const { message, error } = body as ErrorBody;
  if (typeof message === 'string' && message.length > 0) return message;
  if (Array.isArray(message)) return message.filter((item) => typeof item === 'string').join('; ');
  if (typeof error === 'string' && error.length > 0) return error;

  return `запрос отклонён, код ${String(status)}`;
};

const authHeaders = (): Record<string, string> => {
  const token = useSessionStore.getState().accessToken;

  return token === null ? {} : { authorization: `Bearer ${token}` };
};

/** Одно обновление пары на все параллельные запросы: иначе первый же экран прокрутит токен трижды. */
let refreshing: Promise<boolean> | null = null;

const refreshSession = async (): Promise<boolean> => {
  refreshing ??= (async () => {
    try {
      const response = await fetch('/api/auth/refresh', { method: 'POST' });
      if (!response.ok) {
        // Недоступный сервер это не отозванная сессия: вкладку разлогинивать нельзя
        if (response.status >= 500) return false;
        useSessionStore.getState().clear();
        return false;
      }

      const session = sessionResponseSchema.parse(await response.json());
      useSessionStore.getState().setSession(session);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
};

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** Запрос без токена: вход, обновление пары и стадии готовности стенда. */
  readonly anonymous?: boolean;
}

const send = async (path: string, options: RequestOptions): Promise<Response> => {
  const startedAt = startedAtMs();
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.anonymous === true ? {} : authHeaders()),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const serverTime = response.headers.get(SERVER_TIME_HEADER);
  if (serverTime !== null) applyServerTime(serverTime, startedAt);

  return response;
};

/**
 * Запрос к шлюзу. Истёкший токен доступа обновляется один раз и запрос повторяется:
 * человек не должен видеть отказ там, где достаточно прокрутить пару токенов.
 */
export const request = async <T>(
  path: string,
  parse: (value: unknown) => T,
  options: RequestOptions = {},
): Promise<T> => {
  let response: Response;
  try {
    response = await send(path, options);
  } catch (error) {
    throw new ApiError(0, error instanceof Error ? error.message : 'сеть недоступна');
  }

  if (response.status === 401 && options.anonymous !== true) {
    const refreshed = await refreshSession();
    if (refreshed) {
      try {
        response = await send(path, options);
      } catch (error) {
        throw new ApiError(0, error instanceof Error ? error.message : 'сеть недоступна');
      }
    }
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new ApiError(response.status, messageOf(body, response.status));
  }

  if (response.status === 204) return parse(undefined);

  return parse(await response.json());
};
