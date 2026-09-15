import { useQuery } from '@tanstack/react-query';
import type { LineStatus } from '@fieldstream/contracts';
import { api } from '../../../shared/api/endpoints.js';
import { queryKeys } from '../../../shared/api/query-keys.js';

export const LINES_POLL_MS = 1_000;

const NO_LINES: readonly LineStatus[] = [];

export interface LabLines {
  readonly lines: readonly LineStatus[];
  readonly hasData: boolean;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

/** Снимки линий от сборщика с опросом раз в секунду. */
export const useLabLines = (): LabLines => {
  const query = useQuery({
    queryKey: queryKeys.labLines,
    queryFn: () => api.labLines(),
    refetchInterval: LINES_POLL_MS,
  });

  return {
    lines: query.data?.lines ?? NO_LINES,
    hasData: query.data !== undefined,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
};
