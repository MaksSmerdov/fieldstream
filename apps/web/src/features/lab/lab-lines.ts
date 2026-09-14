import type { LineStatus, TopologyResponse } from '@fieldstream/contracts';

export interface ChaosDevice {
  readonly code: string;
  readonly label: string | null;
  readonly profileKey: string | null;
}

export interface ChaosLine {
  readonly code: string;
  readonly devices: readonly ChaosDevice[];
}

export interface Selection {
  readonly line: ChaosLine;
  readonly device: ChaosDevice;
}

/** Линии и приборы панели: имена и модели из топологии, плюс то, что есть только в снимках. */
export const chaosLines = (
  topology: TopologyResponse | undefined,
  snapshots: readonly LineStatus[],
): ChaosLine[] => {
  const byCode = new Map<string, readonly ChaosDevice[]>();

  const topologyLines = (topology?.sites ?? [])
    .flatMap((site) => site.gateways)
    .flatMap((gateway) => gateway.lines);
  for (const line of topologyLines) {
    byCode.set(
      line.code,
      line.devices.map((device) => ({
        code: device.code,
        label: device.label,
        profileKey: device.profileKey,
      })),
    );
  }

  for (const snapshot of snapshots) {
    const devices = byCode.get(snapshot.lineCode) ?? [];
    const known = new Set(devices.map((device) => device.code));
    const extra = snapshot.devices
      .filter((device) => !known.has(device.deviceCode))
      .map((device) => ({ code: device.deviceCode, label: null, profileKey: null }));
    byCode.set(snapshot.lineCode, [...devices, ...extra]);
  }

  return [...byCode.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en', { numeric: true }))
    .map(([code, devices]) => ({ code, devices }));
};

/** Прибор по коду из адреса, иначе первый прибор первой линии. */
export const selectDevice = (
  lines: readonly ChaosLine[],
  requested: string | null,
): Selection | null => {
  for (const line of lines) {
    const device = line.devices.find((item) => item.code === requested);
    if (device !== undefined) return { line, device };
  }

  for (const line of lines) {
    const device = line.devices[0];
    if (device !== undefined) return { line, device };
  }

  return null;
};
