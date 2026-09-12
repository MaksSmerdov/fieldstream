import type { TopologyDevice, TopologyResponse } from '@fieldstream/contracts';

/** Изменение прибора в дереве: приходит из живого события и накладывается точечно. */
export type DevicePatch = Partial<Omit<TopologyDevice, 'code'>>;

/** Прибор в дереве по коду: нужен, чтобы живое событие знало подпись прибора и его линию. */
export const findDevice = (
  tree: TopologyResponse | undefined,
  deviceCode: string,
): TopologyDevice | null => {
  if (tree === undefined) return null;

  for (const site of tree.sites) {
    for (const gateway of site.gateways) {
      for (const line of gateway.lines) {
        const found = line.devices.find((device) => device.code === deviceCode);
        if (found !== undefined) return found;
      }
    }
  }

  return null;
};

/**
 * Замена одного прибора в дереве объектов. Если такого прибора в дереве нет, возвращается
 * прежняя ссылка: событие о чужом приборе не должно приводить к перерисовке экрана.
 */
export const patchTopologyDevice = (
  tree: TopologyResponse,
  deviceCode: string,
  patch: DevicePatch,
): TopologyResponse => {
  if (findDevice(tree, deviceCode) === null) return tree;

  return {
    ...tree,
    sites: tree.sites.map((site) => ({
      ...site,
      gateways: site.gateways.map((gateway) => ({
        ...gateway,
        lines: gateway.lines.map((line) =>
          line.devices.some((device) => device.code === deviceCode)
            ? {
                ...line,
                devices: line.devices.map((device) =>
                  device.code === deviceCode ? { ...device, ...patch } : device,
                ),
              }
            : line,
        ),
      })),
    })),
  };
};

/** Сводка обзорного экрана: считается из дерева, а не отдельным запросом. */
export interface TopologySummary {
  readonly devices: number;
  readonly online: number;
  readonly offline: number;
  readonly stale: number;
  readonly activeAlarms: number;
  readonly acked: number;
}

export const summarize = (tree: TopologyResponse | undefined): TopologySummary => {
  const devices =
    tree?.sites.flatMap((site) =>
      site.gateways.flatMap((gateway) => gateway.lines.flatMap((line) => line.devices)),
    ) ?? [];

  return {
    devices: devices.length,
    online: devices.filter((device) => device.status === 'online').length,
    offline: devices.filter((device) => device.status === 'offline').length,
    stale: devices.filter((device) => device.stale).length,
    activeAlarms: devices.reduce((total, device) => total + device.activeAlarms, 0),
    acked: 0,
  };
};
