import { useQuery } from '@tanstack/react-query';
import type { ScenarioRun, ScenarioSummary } from '@fieldstream/contracts';
import { api } from '../../../../shared/api/endpoints.js';
import { queryKeys } from '../../../../shared/api/query-keys.js';

export const SCENARIOS_POLL_MS = 5_000;

const NO_SCENARIOS: readonly ScenarioSummary[] = [];

export interface LabScenarios {
  readonly scenarios: readonly ScenarioSummary[];
  readonly activeRun: ScenarioRun | null;
  readonly hasData: boolean;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

/** Сценарии стенда с последними прогонами и идущим прогоном, опрос раз в пять секунд. */
export const useScenarios = (): LabScenarios => {
  const query = useQuery({
    queryKey: queryKeys.scenarios,
    queryFn: () => api.scenarios(),
    refetchInterval: SCENARIOS_POLL_MS,
  });

  return {
    scenarios: query.data?.scenarios ?? NO_SCENARIOS,
    activeRun: query.data?.activeRun ?? null,
    hasData: query.data !== undefined,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
};
