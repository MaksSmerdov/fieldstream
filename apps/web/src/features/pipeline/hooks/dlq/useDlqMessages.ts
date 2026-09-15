import { useEffect, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { DlqListResponse, DlqMessage, PipelineResponse } from '@fieldstream/contracts';
import { api } from '../../../../shared/api/endpoints.js';
import { queryKeys } from '../../../../shared/api/query-keys.js';

/** Сколько сообщений очереди берём за раз. */
export const DLQ_PAGE_SIZE = 20;

export interface DlqMessages {
  readonly items: readonly DlqMessage[];
  /** Страницы хоть раз пришли: неудачная догрузка не повод убирать список. */
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
 * Сообщения очереди недоставленных, новые сверху, страницами по курсору. Список не опрашивается
 * сам: он перечитывается, когда в снимке конвейера меняются счёты очереди, но не поверх идущей
 * загрузки, иначе перечитывание отменило бы подгрузку следующей страницы.
 */
export const useDlqMessages = (counts: PipelineResponse['dlq']): DlqMessages => {
  const query = useInfiniteQuery({
    queryKey: queryKeys.dlqMessages,
    queryFn: ({ pageParam }) =>
      api.dlq({ limit: DLQ_PAGE_SIZE, ...(pageParam === null ? {} : { cursor: pageParam }) }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: DlqListResponse) => last.nextCursor,
  });

  const countsKey = `${String(counts.unresolved)}|${String(counts.total)}`;
  const seenKey = useRef(countsKey);
  const { refetch, isFetching } = query;

  useEffect(() => {
    if (seenKey.current === countsKey || isFetching) return;

    seenKey.current = countsKey;
    void refetch({ cancelRefetch: false });
  }, [countsKey, isFetching, refetch]);

  return {
    items: query.data?.pages.flatMap((page) => page.items) ?? [],
    hasData: query.data !== undefined,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => {
      if (query.isFetching) seenKey.current = '';
      void query.fetchNextPage();
    },
    refetch: () => {
      void refetch();
    },
  };
};
