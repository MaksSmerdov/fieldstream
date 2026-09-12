import { useQuery } from '@tanstack/react-query';
import { api } from '../../../shared/api/endpoints.js';
import { queryKeys } from '../../../shared/api/query-keys.js';

/**
 * Коды приборов для фильтра. Берутся из дерева объектов, а не из самих алармов: иначе прибор
 * без единого эпизода в фильтре не найти.
 */
export const useDeviceCodes = (): string[] => {
  const query = useQuery({
    queryKey: queryKeys.topology,
    queryFn: () => api.topology(),
    staleTime: 60_000,
  });

  return (query.data?.sites ?? [])
    .flatMap((site) => site.gateways)
    .flatMap((gateway) => gateway.lines)
    .flatMap((line) => line.devices)
    .map((device) => device.code)
    .sort((left, right) => left.localeCompare(right));
};
