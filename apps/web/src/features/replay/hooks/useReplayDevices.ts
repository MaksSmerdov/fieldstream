import { useQuery } from '@tanstack/react-query';
import { api } from '../../../shared/api/endpoints.js';
import { queryKeys } from '../../../shared/api/query-keys.js';
import { CHAMBER_PROFILE } from '../../lab/fault-kinds.js';

export interface ReplayDevice {
  readonly code: string;
  readonly label: string;
  readonly profileKey: string;
}

export interface ReplayDevices {
  readonly devices: readonly ReplayDevice[];
  /** Коды холодильных камер: для быстрого выбора и примера правки. */
  readonly chambers: readonly string[];
  readonly hasData: boolean;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

const NO_DEVICES: readonly ReplayDevice[] = [];

/** Приборы стенда из дерева объектов: коды, имена и модели для выбора в форме. */
export const useReplayDevices = (): ReplayDevices => {
  const query = useQuery({
    queryKey: queryKeys.topology,
    queryFn: () => api.topology(),
    staleTime: 60_000,
  });

  const devices =
    query.data === undefined
      ? NO_DEVICES
      : query.data.sites
          .flatMap((site) => site.gateways)
          .flatMap((gateway) => gateway.lines)
          .flatMap((line) => line.devices)
          .map((device) => ({
            code: device.code,
            label: device.label,
            profileKey: device.profileKey,
          }))
          .sort((left, right) => left.code.localeCompare(right.code, 'en', { numeric: true }));

  return {
    devices,
    chambers: devices
      .filter((device) => device.profileKey === CHAMBER_PROFILE)
      .map((device) => device.code),
    hasData: query.data !== undefined,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
};
