import { useQuery } from '@tanstack/react-query';
import type { TopologyResponse } from '@fieldstream/contracts';
import { api } from '../../../shared/api/endpoints.js';
import { queryKeys } from '../../../shared/api/query-keys.js';

export interface LabTopology {
  readonly topology: TopologyResponse | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

/** Дерево объектов стенда: имена и модели приборов для панели хаоса. */
export const useLabTopology = (): LabTopology => {
  const query = useQuery({
    queryKey: queryKeys.topology,
    queryFn: () => api.topology(),
    staleTime: 60_000,
  });

  return {
    topology: query.data,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
};
