import { useQueries } from '@tanstack/react-query';
import type { AlarmRuleView } from '@fieldstream/contracts';
import { api } from '../../../shared/api/endpoints.js';
import { queryKeys } from '../../../shared/api/query-keys.js';
import type { RuleCatalog } from '../replay-form.js';

/** Как часто перечитывать уставки, пока форма открыта: их могут поменять в другой вкладке. */
const RULES_REFRESH_MS = 30_000;

export interface DeviceRules extends RuleCatalog {
  readonly error: unknown;
  readonly refetch: () => void;
}

/**
 * Текущие уставки выбранных приборов через тот же запрос, что и вкладка уставок прибора: по ним
 * форма подсказывает текущее значение и заранее ловит правку, которую шлюз отвергнет.
 */
export const useDeviceRules = (codes: readonly string[]): DeviceRules => {
  const results = useQueries({
    queries: codes.map((code) => ({
      queryKey: queryKeys.alarmRules(code),
      queryFn: () => api.alarmRules(code),
      refetchInterval: RULES_REFRESH_MS,
      refetchOnWindowFocus: true,
    })),
  });

  const byDevice = new Map<string, readonly AlarmRuleView[]>();
  results.forEach((result, index) => {
    const code = codes[index];
    if (code !== undefined && result.data !== undefined) byDevice.set(code, result.data.rules);
  });
  const failed = results.find((result) => result.isError && result.data === undefined);

  return {
    byDevice,
    loaded: codes.length > 0 && results.every((result) => result.data !== undefined),
    failed: failed !== undefined,
    error: failed?.error ?? null,
    refetch: () => {
      for (const result of results) {
        if (result.isError) void result.refetch();
      }
    },
  };
};
