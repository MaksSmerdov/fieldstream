import { useInfiniteQuery } from '@tanstack/react-query';
import type { AlarmListItem, AlarmsQuery, AlarmsResponse } from '@fieldstream/contracts';
import { api } from '../../../shared/api/endpoints.js';
import { queryKeys } from '../../../shared/api/query-keys.js';

/** Сколько эпизодов берём за раз: лента листается курсором, а не смещением. */
const PAGE_SIZE = 50;

export interface AlarmFeed {
  readonly items: readonly AlarmListItem[];
  readonly serverTime: string | undefined;
  /** Страницы хоть раз пришли: неудачная догрузка не повод убирать ленту с экрана. */
  readonly hasData: boolean;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loadMore: () => void;
  readonly refetch: () => void;
}

/**
 * Лента алармов. Страницы берутся курсором: при смещении новый эпизод во главе сдвинул бы всё
 * вниз, и вторая страница повторила бы конец первой.
 */
export const useAlarmFeed = (filters: Partial<AlarmsQuery>): AlarmFeed => {
  const query = useInfiniteQuery({
    queryKey: queryKeys.alarms({ ...filters, limit: PAGE_SIZE }),
    queryFn: ({ pageParam }) =>
      api.alarms({
        ...filters,
        limit: PAGE_SIZE,
        ...(pageParam === null ? {} : { cursor: pageParam }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: AlarmsResponse) => last.nextCursor,
  });

  return {
    items: query.data?.pages.flatMap((page) => page.items) ?? [],
    serverTime: query.data?.pages[0]?.serverTime,
    hasData: query.data !== undefined,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => {
      void query.fetchNextPage();
    },
    refetch: () => {
      void query.refetch();
    },
  };
};
