import { skipToken, useQuery } from '@tanstack/react-query';
import type { ReplayDiff, ReplayRun } from '@fieldstream/contracts';
import { api } from '../../../../shared/api/endpoints.js';
import { queryKeys } from '../../../../shared/api/query-keys.js';

export interface ReplayDiffResult {
  readonly diff: ReplayDiff | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

/** Разница срабатываний завершённого прогона. Итог прогона не меняется, перечитывать его незачем. */
export const useReplayDiff = (run: ReplayRun, enabled: boolean): ReplayDiffResult => {
  const { id } = run;
  const query = useQuery({
    queryKey: queryKeys.replayDiff(id),
    queryFn: enabled ? () => api.replayDiff(id) : skipToken,
    staleTime: Number.POSITIVE_INFINITY,
  });

  return {
    diff: query.data,
    isPending: enabled && query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
};
