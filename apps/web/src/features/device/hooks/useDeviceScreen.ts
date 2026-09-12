import { useQuery } from '@tanstack/react-query';
import type { DeviceProfileView, DeviceSnapshot } from '@fieldstream/contracts';
import { api } from '../../../shared/api/endpoints.js';
import { queryKeys } from '../../../shared/api/query-keys.js';

export interface DeviceScreen {
  readonly snapshot: DeviceSnapshot | undefined;
  readonly profile: DeviceProfileView | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

/**
 * Снимок прибора и описание его модели. Описание не меняется между запросами, поэтому живёт
 * в кэше без срока годности: значения обновляются живым каналом, а секции и словари состояний
 * перезапрашивать не с чего.
 */
export const useDeviceScreen = (code: string): DeviceScreen => {
  const snapshot = useQuery({
    queryKey: queryKeys.snapshot(code),
    queryFn: () => api.snapshot(code),
  });
  const profile = useQuery({
    queryKey: queryKeys.profile(code),
    queryFn: () => api.profile(code),
    staleTime: Infinity,
  });

  return {
    snapshot: snapshot.data,
    profile: profile.data,
    isPending: snapshot.isPending || profile.isPending,
    isError: snapshot.isError || profile.isError,
    error: snapshot.error ?? profile.error,
    refetch: () => {
      void snapshot.refetch();
      void profile.refetch();
    },
  };
};
