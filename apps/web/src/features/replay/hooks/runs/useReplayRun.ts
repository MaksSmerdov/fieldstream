import { useEffect } from 'react';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReplayRun } from '@fieldstream/contracts';
import { api } from '../../../../shared/api/endpoints.js';
import { ApiError } from '../../../../shared/api/http.js';
import { queryKeys } from '../../../../shared/api/query-keys.js';
import { isReplayFinished } from '../../replay-words.js';

export const RUN_POLL_MS = 1_000;

/** Ошибка опроса хода, которую повтор не исправит: прогона нет, нет права или ответ не по контракту. */
export const isFatalRunError = (error: unknown): boolean => {
  if (error === null || error === undefined) return false;
  if (!(error instanceof ApiError)) return true;

  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
};

export interface ReplayRunWatch {
  readonly run: ReplayRun | null;
  readonly isPending: boolean;
  readonly pollError: unknown;
  /** Ход больше не узнать: опрос остановлен неустранимой ошибкой. */
  readonly stopped: boolean;
}

/**
 * Выбранный прогон. Завершённый из списка не перечитывается, идущий опрашивается раз в секунду
 * до итога, а после итога перечитывается список: в нём меняется идущий прогон.
 */
export const useReplayRun = (id: string | null, listed: ReplayRun | null): ReplayRunWatch => {
  const client = useQueryClient();
  const known = listed !== null && listed.id === id ? listed : null;
  const settled = known !== null && isReplayFinished(known);

  const query = useQuery({
    queryKey: queryKeys.replayRun(id ?? ''),
    queryFn: id === null || settled ? skipToken : () => api.replayRun(id),
    staleTime: RUN_POLL_MS,
    retry: false,
    refetchInterval: (state) => {
      const { data, error } = state.state;
      if (data !== undefined && isReplayFinished(data)) return false;

      return isFatalRunError(error) ? false : RUN_POLL_MS;
    },
  });

  const polled = id === null ? undefined : query.data;
  const run = settled ? known : (polled ?? known);
  const finishedId =
    polled !== undefined && isReplayFinished(polled) && !settled ? polled.id : null;

  useEffect(() => {
    if (finishedId === null) return;

    void client.invalidateQueries({ queryKey: queryKeys.replayRuns });
  }, [client, finishedId]);

  const stopped = !settled && isFatalRunError(query.error);

  return {
    run,
    isPending: id !== null && run === null && !stopped && query.error === null,
    pollError: settled ? null : query.error,
    stopped,
  };
};
