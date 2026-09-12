import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import type { AlarmListItem, AlarmsResponse } from '@fieldstream/contracts';
import { api } from '../../../shared/api/endpoints.js';
import { useSessionStore } from '../../../shared/auth/session-store.js';
import { getServerNowMs } from '../../../shared/time/serverClock.js';

type Feed = InfiniteData<AlarmsResponse>;

/** Правка одного эпизода во всех открытых страницах ленты: фильтров может быть несколько. */
const patchFeeds = (
  entries: readonly [readonly unknown[], Feed | undefined][],
  id: string,
  patch: Partial<AlarmListItem>,
  apply: (key: readonly unknown[], data: Feed) => void,
): void => {
  for (const [key, data] of entries) {
    if (data === undefined) continue;

    apply(key, {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      })),
    });
  }
};

/**
 * Подтверждение аларма. Отметка ставится до ответа сервера и при отказе снимается обратно:
 * на ленте из сотни строк ожидание читается как несработавшая кнопка.
 */
export const useAckAlarm = (): {
  ack: (id: string) => void;
  pendingId: string | null;
  error: unknown;
} => {
  const client = useQueryClient();
  const email = useSessionStore((state) => state.user?.email);

  const mutation = useMutation({
    mutationFn: (id: string) => api.ackAlarm(id),
    onMutate: async (id: string) => {
      await client.cancelQueries({ queryKey: ['alarms'] });
      const snapshot = client.getQueriesData<Feed>({ queryKey: ['alarms'] });

      patchFeeds(
        snapshot,
        id,
        { ackedBy: email ?? 'вы', ackedAt: new Date(getServerNowMs()).toISOString() },
        (key, data) => {
          client.setQueryData(key, data);
        },
      );

      return { snapshot };
    },
    onError: (_error, _id, context) => {
      for (const [key, data] of context?.snapshot ?? []) client.setQueryData(key, data);
    },
    onSuccess: (alarm) => {
      patchFeeds(
        client.getQueriesData<Feed>({ queryKey: ['alarms'] }),
        alarm.id,
        alarm,
        (key, data) => {
          client.setQueryData(key, data);
        },
      );
    },
  });

  return {
    ack: (id: string) => {
      mutation.mutate(id);
    },
    pendingId: mutation.isPending ? mutation.variables : null,
    error: mutation.error,
  };
};
