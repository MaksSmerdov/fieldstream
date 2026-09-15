import { sessionResponseSchema } from '@fieldstream/contracts';
import { messageOf } from './decide.js';

const REQUEST_TIMEOUT_MS = 15_000;

/** Ответ шлюза. status null, если ответа нет: обрыв сети или таймаут. */
export interface GatewayReply {
  readonly status: number | null;
  readonly body: unknown;
  readonly error: string | null;
}

/** Клиент шлюза: вход по почте и паролю, запросы с токеном доступа. */
export interface GatewayClient {
  readonly login: () => Promise<void>;
  readonly request: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<GatewayReply>;
}

/** Учётная запись, под которой идут запросы. */
export interface Credentials {
  readonly email: string;
  readonly password: string;
}

/** Тело ответа как JSON, а не JSON превращается в null. */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

/** Текст исключения. */
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Создаёт клиент шлюза. Вход не бросает только при ответе с токеном. */
export const createGatewayClient = (baseUrl: string, credentials: Credentials): GatewayClient => {
  let token: string | null = null;

  const send = async (
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    withToken: boolean,
  ): Promise<GatewayReply> => {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(withToken && token !== null ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      return { status: response.status, body: parseJson(await response.text()), error: null };
    } catch (error) {
      return { status: null, body: null, error: errorText(error) };
    }
  };

  return {
    login: async () => {
      const reply = await send(
        'POST',
        '/api/auth/login',
        { email: credentials.email, password: credentials.password },
        false,
      );
      const session = sessionResponseSchema.safeParse(reply.body);
      if (reply.status !== null && reply.status < 300 && session.success) {
        token = session.data.accessToken;
        return;
      }

      const why =
        reply.status === null
          ? `шлюз не ответил: ${reply.error ?? 'нет ответа'}`
          : `шлюз ответил ${reply.status}${messageOf(reply.body) === null ? '' : `: ${messageOf(reply.body) ?? ''}`}`;
      throw new Error(`вход ${credentials.email} не удался, ${why}`);
    },
    request: (method, path, body) => send(method, path, body, true),
  };
};
