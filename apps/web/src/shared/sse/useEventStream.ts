import { useEffect, useRef } from 'react';
import { LIVE_EVENT_KINDS, liveFrameSchema } from '@fieldstream/contracts';
import type { LiveFrame } from '@fieldstream/contracts';
import { useSessionStore } from '../auth/session-store.js';
import { getServerNowMs } from '../time/serverClock.js';
import { useLiveStore } from './live-store.js';

/** Сколько пропущенных keepalive считаем тишиной: сервер шлёт их раз в двадцать секунд. */
const SILENCE_PINGS = 3;
const DEFAULT_PING_MS = 20_000;

export interface EventStreamOptions {
  /** Ключи подписки: `site:SITE-A`, `line:L1`, `device:RC-101`. Пусто означает весь доступный стенд. */
  readonly keys: readonly string[];
  readonly onFrame: (frame: LiveFrame) => void;
  /** Канал попросил перечитать всё: кольцо на сервере не покрывает пропуск. */
  readonly onResync: () => void;
  readonly enabled?: boolean;
}

interface StreamRuntime {
  source: EventSource | null;
  silence: ReturnType<typeof setTimeout> | null;
  seen: Set<string>;
  pingMs: number;
}

/** Адрес потока. Токен едет строкой запроса: заголовки EventSource ставить не умеет. */
const streamUrl = (keys: readonly string[], token: string, lastEventId: string | null): string => {
  const params = new URLSearchParams({ access_token: token });
  if (keys.length > 0) params.set('keys', keys.join(','));
  if (lastEventId !== null) params.set('last_event_id', lastEventId);

  return `/api/events?${params.toString()}`;
};

/**
 * Живой канал вкладки. Одно соединение на все экраны: подписка объявляется ключами, пропуски
 * после обрыва добираются по последнему полученному идентификатору, а сторож тишины сам
 * переоткрывает соединение, если сервер замолчал дольше трёх keepalive. Молчаливая потеря
 * событий здесь худший исход, поэтому кадр `resync` приводит к полному перезапросу данных.
 */
export const useEventStream = (options: EventStreamOptions): void => {
  const token = useSessionStore((state) => state.accessToken);
  const keysKey = options.keys.join(',');
  const handlers = useRef(options);
  handlers.current = options;

  useEffect(() => {
    if (options.enabled === false || token === null) return;

    const runtime: StreamRuntime = {
      source: null,
      silence: null,
      seen: new Set(),
      pingMs: DEFAULT_PING_MS,
    };
    let closed = false;

    const armSilence = (): void => {
      if (runtime.silence !== null) clearTimeout(runtime.silence);
      runtime.silence = setTimeout(() => {
        if (closed) return;
        useLiveStore.getState().setStatus('offline');
        reopen();
      }, runtime.pingMs * SILENCE_PINGS);
    };

    const handle = (kind: string, event: MessageEvent<string>): void => {
      const parsed = liveFrameSchema.safeParse({
        kind,
        id: event.lastEventId.length > 0 ? event.lastEventId : kind,
        data: JSON.parse(event.data) as unknown,
      });
      if (!parsed.success) return;

      const frame = parsed.data;
      if (runtime.seen.has(frame.id)) return;
      runtime.seen.add(frame.id);
      if (runtime.seen.size > 4_000) runtime.seen = new Set([frame.id]);

      useLiveStore.getState().noteFrame(event.lastEventId, getServerNowMs());
      armSilence();

      if (frame.kind === 'hello') {
        runtime.pingMs = frame.data.pingMs;
        useLiveStore.getState().noteHello(frame.data.epoch);
        return;
      }
      if (frame.kind === 'resync') {
        useLiveStore.getState().noteResync();
        handlers.current.onResync();
        return;
      }
      if (frame.kind === 'ping') return;

      handlers.current.onFrame(frame);
    };

    const open = (): void => {
      const source = new EventSource(
        streamUrl(options.keys, token, useLiveStore.getState().lastEventId),
      );
      runtime.source = source;

      source.addEventListener('open', () => {
        useLiveStore.getState().setStatus('live');
        armSilence();
      });
      source.addEventListener('error', () => {
        useLiveStore.getState().setStatus('offline');
      });
      for (const kind of LIVE_EVENT_KINDS) {
        source.addEventListener(kind, (event) => {
          handle(kind, event as MessageEvent<string>);
        });
      }
    };

    /** Переоткрытие по сторожу тишины: своё, потому что браузер считает соединение живым. */
    const reopen = (): void => {
      runtime.source?.close();
      if (closed) return;
      open();
    };

    open();
    armSilence();

    return () => {
      closed = true;
      if (runtime.silence !== null) clearTimeout(runtime.silence);
      runtime.source?.close();
      useLiveStore.getState().setStatus('connecting');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- соединение пересоздаётся по токену и набору ключей, обработчики живут в ref
  }, [token, keysKey, options.enabled]);
};
