import { useQuery } from '@tanstack/react-query';
import type { ReplayRun } from '@fieldstream/contracts';
import { api } from '../../../../shared/api/endpoints.js';
import { queryKeys } from '../../../../shared/api/query-keys.js';

export const RUNS_POLL_MS = 5_000;

const NO_RUNS: readonly ReplayRun[] = [];

export interface ReplayRuns {
  readonly runs: readonly ReplayRun[];
  readonly activeRun: ReplayRun | null;
  readonly retentionMs: number | null;
  readonly hasData: boolean;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

/** Последние перепрогоны, идущий прогон и срок хранения сырых кадров, опрос раз в пять секунд. */
export const useReplayRuns = (): ReplayRuns => {
  const query = useQuery({
    queryKey: queryKeys.replayRuns,
    queryFn: () => api.replayRuns(),
    refetchInterval: RUNS_POLL_MS,
  });

  return {
    runs: query.data?.runs ?? NO_RUNS,
    activeRun: query.data?.activeRun ?? null,
    retentionMs: query.data?.retentionMs ?? null,
    hasData: query.data !== undefined,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
};
