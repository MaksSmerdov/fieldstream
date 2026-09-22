import { liveFrameSchema, sessionResponseSchema } from '@fieldstream/contracts';
import type { LiveFrame } from '@fieldstream/contracts';
import { SystemClock } from '@fieldstream/domain';
import type { Gateway, GatewayReply, HttpMethod, ListenOptions, LiveSample } from './measure.js';
import { errorText } from './report.js';

const REQUEST_LIMIT_MS = 15_000;

/** Заголовок с временем шлюза: по нему считается поправка локальных часов. */
const SERVER_TIME_HEADER = 'x-server-time';

/** Печенье с ключом продления: без него выход из шлюза сессию не закроет. */
const REFRESH_COOKIE = 'fs_refresh';

/**
 * Запрос к шлюзу строкой для ручного повтора. Живёт отдельно от клиента: ту же команду ставят
 * в how замеры, которые шлюз в needs не заявляли, а адрес стенда берут из настроек прогона.
 */
export const howRequest = (
  baseUrl: string,
  method: HttpMethod,
  path: string,
  body?: unknown,
): string =>
  [
    'curl -sS -D -',
    method === 'GET' ? '' : `-X ${method}`,
    `${baseUrl}${path}`,
    "-H 'authorization: Bearer $TOKEN'",
    body === undefined ? '' : "-H 'content-type: application/json'",
    body === undefined ? '' : `-d '${JSON.stringify(body)}'`,
  ]
    .filter((part) => part !== '')
    .join(' ');

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

/** Сообщение об отказе из тела ответа шлюза. */
export const messageOf = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null || !('message' in body)) return null;

  const { message } = body;
  return typeof message === 'string' && message.length > 0 ? message : null;
};

/** Разбор одного кадра потока событий: вид, номер и тело по контракту живого канала. */
export const parseFrame = (block: string): LiveFrame | null => {
  const data: string[] = [];
  let kind = 'message';
  let id = '';

  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');

    if (field === 'event') kind = value;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;

  const parsed = liveFrameSchema.safeParse({ kind, id, data: parseJson(data.join('\n')) });
  return parsed.success ? parsed.data : null;
};

/** Отметка времени шлюза из ответа: непонятный заголовок это null. */
const serverTimeOf = (headers: Headers): number | null => {
  const raw = headers.get(SERVER_TIME_HEADER);
  if (raw === null) return null;

  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
};

/**
 * Клиент шлюза. Часы контейнера и часы хоста расходятся, поэтому каждое общение со шлюзом
 * уточняет поправку: заголовок x-server-time в ответе и поле serverTime кадра hello дают время
 * шлюза, а разница с локальными часами и есть поправка. Задержку кадров считать можно только
 * в шкале шлюза, иначе расхождение часов попадёт прямо в цифру.
 */
export const createGateway = (baseUrl: string, credentials: Credentials): Gateway => {
  let token: string | null = null;
  let cookie: string | null = null;
  let offset = 0;

  const keepCookie = (headers: Headers): void => {
    const found = headers
      .getSetCookie()
      .find((item) => item.startsWith(`${REFRESH_COOKIE}=`))
      ?.split(';')[0];
    if (found !== undefined) cookie = found;
  };

  const send = async (
    method: HttpMethod,
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
          ...(cookie === null ? {} : { cookie }),
        },
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
      const at = serverTimeOf(response.headers);
      if (at !== null) offset = at - SystemClock.now();
      keepCookie(response.headers);

      return { status: response.status, body: parseJson(await response.text()), error: null };
    } catch (error) {
      return { status: null, body: null, error: errorText(error) };
    }
  };

  const bearer = (): string => {
    if (token === null) throw new Error('вход в шлюз не выполнен: нет токена доступа');
    return token;
  };

  const listen = async (options: ListenOptions): Promise<readonly LiveSample[]> => {
    const query = new URLSearchParams();
    if (options.keys.length > 0) query.set('keys', options.keys.join(','));

    const controller = new AbortController();
    const limit = setTimeout(() => {
      controller.abort();
    }, options.limitMs);
    limit.unref();
    options.signal?.addEventListener('abort', () => {
      controller.abort();
    });
    const samples: LiveSample[] = [];

    try {
      const response = await fetch(`${baseUrl}/api/events?${query.toString()}`, {
        headers: { authorization: `Bearer ${bearer()}`, accept: 'text/event-stream' },
        signal: controller.signal,
      });
      const at = serverTimeOf(response.headers);
      if (at !== null) offset = at - SystemClock.now();
      if (!response.ok || response.body === null) {
        throw new Error(`живой канал не открылся, шлюз ответил ${response.status}`);
      }

      const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
      const decoder = new TextDecoder();
      let rest = '';

      while (samples.length < options.count) {
        const chunk = await reader.read();
        if (chunk.done) break;

        const atLocalMs = SystemClock.now();
        rest += decoder.decode(chunk.value, { stream: true });
        const blocks = rest.split(/\r?\n\r?\n/);
        rest = blocks.pop() ?? '';

        for (const block of blocks) {
          const frame = parseFrame(block);
          if (frame === null) continue;
          if (frame.kind === 'hello') offset = Date.parse(frame.data.serverTime) - atLocalMs;
          else if (frame.kind === options.kind) samples.push({ frame, atMs: atLocalMs + offset });
        }
      }

      await reader.cancel().catch(() => undefined);
    } catch (error) {
      if (!controller.signal.aborted) throw new Error(errorText(error));
    } finally {
      clearTimeout(limit);
    }
    if (options.signal?.aborted === true) {
      throw new Error('ожидание событий снято: прогон прерван');
    }

    return samples;
  };

  return {
    baseUrl,
    email: credentials.email,
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
    logout: async () => {
      if (cookie === null) return false;

      const reply = await send('POST', '/api/auth/logout', undefined, false);
      const closed = reply.status !== null && reply.status < 300;
      if (closed) {
        cookie = null;
        token = null;
      }

      return closed;
    },
    request: (method, path, body) => send(method, path, body, true),
    offsetMs: () => offset,
    now: () => SystemClock.now() + offset,
    listen,
    howListen: (keys) =>
      `curl -sS -N '${baseUrl}/api/events?keys=${keys.join(',')}' -H 'authorization: Bearer $TOKEN'`,
  };
};
