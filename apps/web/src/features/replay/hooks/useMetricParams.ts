import { useQueries } from '@tanstack/react-query';
import type { ProfileParamView } from '@fieldstream/contracts';
import { api } from '../../../shared/api/endpoints.js';
import { queryKeys } from '../../../shared/api/query-keys.js';
import { useReplayDevices } from './useReplayDevices.js';

export interface MetricParams {
  readonly paramOf: (metricKey: string) => ProfileParamView | undefined;
  readonly labelOf: (metricKey: string) => string;
}

const UNKNOWN_PROFILE = '';

/**
 * Подписи, единицы и точность параметров. Описание модели одно на все приборы этой модели,
 * поэтому запрашивается по одному прибору от каждой модели, а не по всем выбранным.
 */
export const useMetricParams = (codes: readonly string[]): MetricParams => {
  const { devices } = useReplayDevices();
  const profileOf = new Map(devices.map((device) => [device.code, device.profileKey]));

  const representatives = new Map<string, string>();
  for (const code of codes) {
    const profile = profileOf.get(code) ?? UNKNOWN_PROFILE;
    if (!representatives.has(profile)) representatives.set(profile, code);
  }

  const results = useQueries({
    queries: [...representatives.values()].map((code) => ({
      queryKey: queryKeys.profile(code),
      queryFn: () => api.profile(code),
      staleTime: 5 * 60_000,
    })),
  });

  const params = new Map<string, ProfileParamView>();
  for (const result of results) {
    for (const section of result.data?.sections ?? []) {
      for (const param of section.params) {
        if (!params.has(param.metricKey)) params.set(param.metricKey, param);
      }
    }
  }

  return {
    paramOf: (metricKey) => params.get(metricKey),
    labelOf: (metricKey) => params.get(metricKey)?.label ?? metricKey,
  };
};
