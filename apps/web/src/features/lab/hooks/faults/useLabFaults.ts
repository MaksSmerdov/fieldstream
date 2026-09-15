import { useQuery } from '@tanstack/react-query';
import type { SimFault } from '@fieldstream/contracts';
import { api } from '../../../../shared/api/endpoints.js';
import { ApiError } from '../../../../shared/api/http.js';
import { queryKeys } from '../../../../shared/api/query-keys.js';

export const FAULTS_POLL_MS = 3_000;

export type FaultsStatus = 'pending' | 'ready' | 'unavailable' | 'error';

const NO_FAULTS: readonly SimFault[] = [];

export interface LabFaults {
  readonly faults: readonly SimFault[];
  readonly status: FaultsStatus;
  readonly hasData: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

/** Шлюз ответил, что не видит симулятор стенда. */
export const isSimulatorUnavailable = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 503;

const statusOf = (isError: boolean, isPending: boolean, error: unknown): FaultsStatus => {
  if (isError) return isSimulatorUnavailable(error) ? 'unavailable' : 'error';

  return isPending ? 'pending' : 'ready';
};

/** Действующие поломки стенда с опросом раз в три секунды. */
export const useLabFaults = (): LabFaults => {
  const query = useQuery({
    queryKey: queryKeys.labFaults,
    queryFn: () => api.labFaults(),
    refetchInterval: FAULTS_POLL_MS,
    retry: false,
  });

  return {
    faults: query.data?.faults ?? NO_FAULTS,
    status: statusOf(query.isError, query.isPending, query.error),
    hasData: query.data !== undefined,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
};
