import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TopologyDevice, TopologyResponse } from '@fieldstream/contracts';
import { api } from '../../../shared/api/endpoints.js';
import { queryKeys } from '../../../shared/api/query-keys.js';
import { summarize } from '../topology-patch.js';
import type { TopologySummary } from '../topology-patch.js';

/** Ряд списка: заголовок узла или прибор. Дерево разворачивается в плоский список ради окна прокрутки. */
export type TopologyRow =
  | { readonly kind: 'site'; readonly key: string; readonly code: string; readonly name: string }
  | {
      readonly kind: 'line';
      readonly key: string;
      readonly gatewayCode: string;
      readonly lineCode: string;
      readonly baud: number;
      readonly pollIntervalMs: number;
      readonly planMode: 'merged' | 'naive';
      readonly enabled: boolean;
      readonly devices: number;
      readonly offline: number;
    }
  | { readonly kind: 'device'; readonly key: string; readonly device: TopologyDevice };

const rowsOf = (tree: TopologyResponse | undefined): TopologyRow[] => {
  if (tree === undefined) return [];
  const rows: TopologyRow[] = [];

  for (const site of tree.sites) {
    rows.push({ kind: 'site', key: `site:${site.code}`, code: site.code, name: site.name });

    for (const gateway of site.gateways) {
      for (const line of gateway.lines) {
        rows.push({
          kind: 'line',
          key: `line:${line.code}`,
          gatewayCode: gateway.code,
          lineCode: line.code,
          baud: line.baud,
          pollIntervalMs: line.pollIntervalMs,
          planMode: line.planMode,
          enabled: line.enabled,
          devices: line.devices.length,
          offline: line.devices.filter((device) => device.status === 'offline').length,
        });

        for (const device of line.devices) {
          rows.push({ kind: 'device', key: `device:${device.code}`, device });
        }
      }
    }
  }

  return rows;
};

export interface TopologyView {
  readonly rows: TopologyRow[];
  readonly summary: TopologySummary;
  /** Данные хоть раз пришли: неудачный перезапрос не повод прятать то, что уже показано. */
  readonly hasData: boolean;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

/**
 * Дерево объектов для обзора. Живые события правят тот же кэш, поэтому список обновляется
 * без повторных запросов, а плоские ряды позволяют держать в окне прокрутки и двадцать четыре
 * прибора, и пятьсот.
 */
export const useTopologyRows = (): TopologyView => {
  const query = useQuery({ queryKey: queryKeys.topology, queryFn: () => api.topology() });
  const rows = useMemo(() => rowsOf(query.data), [query.data]);
  const summary = useMemo(() => summarize(query.data), [query.data]);

  return {
    rows,
    summary,
    hasData: query.data !== undefined,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
};
