import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReplayRequest } from '@fieldstream/contracts';
import { api } from '../../../../shared/api/endpoints.js';
import { ApiError } from '../../../../shared/api/http.js';
import { queryKeys } from '../../../../shared/api/query-keys.js';

/** Шлюз отказал в постановке, потому что на стенде уже есть активный перепрогон. */
export const isBusyRejection = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409;

export interface ReplayLaunch {
  readonly launch: (request: ReplayRequest) => void;
  readonly sending: boolean;
  readonly failure: unknown;
  readonly dismiss: () => void;
}

/**
 * Постановка перепрогона. Принятый прогон сразу становится выбранным; на 409 шлюз отвечает
 * только текстом, поэтому активный прогон берётся из перечитанного списка.
 */
export const useReplayLaunch = (onFollow: (runId: string) => void): ReplayLaunch => {
  const client = useQueryClient();

  const mutation = useMutation({
    mutationFn: (request: ReplayRequest) => api.startReplay(request),
    onSuccess: async (accepted) => {
      client.setQueryData(queryKeys.replayRun(accepted.id), accepted);
      onFollow(accepted.id);
      await client.invalidateQueries({ queryKey: queryKeys.replayRuns });
    },
    onError: async (error) => {
      if (!isBusyRejection(error)) return;

      const fresh = await client
        .query({ queryKey: queryKeys.replayRuns, queryFn: () => api.replayRuns(), staleTime: 0 })
        .catch(() => null);
      if (fresh?.activeRun != null) onFollow(fresh.activeRun.id);
    },
  });

  return {
    launch: (request) => {
      mutation.mutate(request);
    },
    sending: mutation.isPending,
    failure: mutation.error,
    dismiss: () => {
      mutation.reset();
    },
  };
};
