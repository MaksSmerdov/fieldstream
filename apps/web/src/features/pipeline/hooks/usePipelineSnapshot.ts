import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { PipelineResponse } from '@fieldstream/contracts';
import { api } from '../../../shared/api/endpoints.js';
import { queryKeys } from '../../../shared/api/query-keys.js';

export const PIPELINE_POLL_MS = 2_000;

export interface PipelineSnapshot {
  readonly data: PipelineResponse | undefined;
  readonly hasData: boolean;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

/** Снимок конвейера с опросом раз в две секунды; между опросами на экране прежние данные. */
export const usePipelineSnapshot = (): PipelineSnapshot => {
  const query = useQuery({
    queryKey: queryKeys.pipeline,
    queryFn: () => api.pipeline(),
    refetchInterval: PIPELINE_POLL_MS,
    placeholderData: keepPreviousData,
  });

  return {
    data: query.data,
    hasData: query.data !== undefined,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
};
