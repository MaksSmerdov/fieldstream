import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import type {
  AlarmListItem,
  AlarmsResponse,
  DeviceSnapshot,
  LiveAlarm,
  LiveDeviceState,
  LiveFrame,
  LiveReading,
  TopologyResponse,
} from '@fieldstream/contracts';
import { findDevice, patchTopologyDevice } from '../../features/topology/topology-patch.js';

import { queryKeys } from '../api/query-keys.js';
import { useEventStream } from './useEventStream.js';

/** Лента листается курсором, поэтому в кэше лежат страницы, а не один список. */
type AlarmFeedData = InfiniteData<AlarmsResponse>;

/**
 * Живое событие правит кэш точечно и не ходит в сеть. Прежний подход, перезапрос всего окна
 * графика раз в секунду при данных раз в десять секунд, давал нагрузку на пустом месте:
 * данные уже пришли событием, спрашивать их снова незачем.
 */
export const useLivePatch = (keys: readonly string[], enabled = true): void => {
  const client = useQueryClient();

  const patchReading = useCallback(
    (reading: LiveReading): void => {
      client.setQueryData<TopologyResponse>(queryKeys.topology, (tree) =>
        tree === undefined
          ? tree
          : patchTopologyDevice(tree, reading.deviceCode, {
              stale: false,
              staleSince: reading.ts,
              mode: reading.mode,
            }),
      );

      client.setQueryData<DeviceSnapshot>(queryKeys.snapshot(reading.deviceCode), (snapshot) =>
        snapshot === undefined
          ? snapshot
          : {
              ...snapshot,
              ts: reading.ts,
              mode: reading.mode,
              stale: false,
              metrics: snapshot.metrics.map((metric) => {
                const value = reading.metrics[metric.metricKey];

                return value === undefined
                  ? metric
                  : { ...metric, value, quality: reading.quality, ts: reading.ts };
              }),
            },
      );
    },
    [client],
  );

  const patchState = useCallback(
    (state: LiveDeviceState): void => {
      client.setQueryData<TopologyResponse>(queryKeys.topology, (tree) =>
        tree === undefined
          ? tree
          : patchTopologyDevice(tree, state.deviceCode, {
              status: state.status,
              reason: state.reason,
              mode: state.mode,
              since: state.since,
              lastOkAt: state.lastOkAt,
            }),
      );

      client.setQueryData<DeviceSnapshot>(queryKeys.snapshot(state.deviceCode), (snapshot) =>
        snapshot === undefined
          ? snapshot
          : {
              ...snapshot,
              status: state.status,
              reason: state.reason,
              mode: state.mode,
              since: state.since,
              lastOkAt: state.lastOkAt,
              consecutiveErrors: state.consecutiveErrors,
            },
      );
    },
    [client],
  );

  const patchAlarm = useCallback(
    (alarm: LiveAlarm): void => {
      const tree = client.getQueryData<TopologyResponse>(queryKeys.topology);
      const device = findDevice(tree, alarm.deviceCode);

      const item: AlarmListItem = {
        id: alarm.alarmId,
        deviceCode: alarm.deviceCode,
        deviceLabel: device?.label ?? alarm.deviceCode,
        metricKey: alarm.metricKey,
        mode: alarm.mode,
        severity: alarm.severity,
        boundary: alarm.boundary,
        value: alarm.value,
        threshold: alarm.threshold,
        occurredAt: alarm.occurredAt,
        clearedAt: alarm.state === 'cleared' ? alarm.occurredAt : null,
        clearedValue: alarm.state === 'cleared' ? alarm.value : null,
        ackedBy: null,
        ackedAt: null,
        active: alarm.state === 'raised',
      };

      // Лента открыта с разными фильтрами: правим все страницы, где этот эпизод уместен
      for (const [key, data] of client.getQueriesData<AlarmFeedData>({ queryKey: ['alarms'] })) {
        const first = data?.pages[0];
        if (data === undefined || first === undefined) continue;

        const known = data.pages.some((page) =>
          page.items.some((candidate) => candidate.id === item.id),
        );
        const pages = known
          ? data.pages.map((page) => ({
              ...page,
              items: page.items.map((candidate) =>
                candidate.id === item.id
                  ? {
                      ...candidate,
                      ...item,
                      ackedBy: candidate.ackedBy,
                      ackedAt: candidate.ackedAt,
                    }
                  : candidate,
              ),
            }))
          : [{ ...first, items: [item, ...first.items] }, ...data.pages.slice(1)];

        client.setQueryData<AlarmFeedData>(key, { ...data, pages });
      }

      client.setQueryData<TopologyResponse>(queryKeys.topology, (current) => {
        if (current === undefined || device === null) return current;
        const delta = alarm.state === 'raised' ? 1 : -1;

        return patchTopologyDevice(current, alarm.deviceCode, {
          activeAlarms: Math.max(0, device.activeAlarms + delta),
          worstSeverity: alarm.state === 'raised' ? alarm.severity : device.worstSeverity,
        });
      });
    },
    [client],
  );

  const onFrame = useCallback(
    (frame: LiveFrame): void => {
      if (frame.kind === 'reading') patchReading(frame.data);
      if (frame.kind === 'device-state') patchState(frame.data);
      if (frame.kind === 'alarm') patchAlarm(frame.data);
    },
    [patchAlarm, patchReading, patchState],
  );

  /** Кольцо на сервере не покрыло пропуск: только здесь живой канал идёт к сети. */
  const onResync = useCallback((): void => {
    void client.invalidateQueries();
  }, [client]);

  useEventStream({ keys, onFrame, onResync, enabled });
};
