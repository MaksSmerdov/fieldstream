import type {
  DeviceEvent,
  DeviceEventKind,
  DeviceMode,
  HealthStatus,
} from '@fieldstream/contracts';
import { toIsoTimestamp } from './clock.js';

/** Снимок прибора, из пары которых выводятся события. */
export interface DeviceSnapshot {
  deviceCode: string;
  atMs: number;
  status: HealthStatus;
  mode: DeviceMode;
  /** null это «неизвестно»: переход из неизвестного события не порождает. */
  doorOpen: boolean | null;
  defrostActive: boolean | null;
}

/**
 * Детектор событий прибора по двум снимкам. Порядок фиксирован и совпадает
 * с порядком видов в deviceEventKindSchema: реплей обязан давать тот же список.
 */
export const detectDeviceEvents = (
  prev: DeviceSnapshot | null,
  curr: DeviceSnapshot,
): DeviceEvent[] => {
  if (prev === null) {
    return [];
  }

  const events: DeviceEvent[] = [];
  const occurredAt = toIsoTimestamp(curr.atMs);
  const add = (kind: DeviceEventKind, payload: Record<string, unknown>): void => {
    events.push({ deviceCode: curr.deviceCode, kind, occurredAt, payload });
  };

  if (prev.mode !== curr.mode) {
    add('mode_changed', { from: prev.mode, to: curr.mode });
  }
  if (prev.doorOpen === false && curr.doorOpen === true) {
    add('door_opened', {});
  }
  if (prev.doorOpen === true && curr.doorOpen === false) {
    add('door_closed', {});
  }
  if (prev.defrostActive === false && curr.defrostActive === true) {
    add('defrost_started', {});
  }
  if (prev.defrostActive === true && curr.defrostActive === false) {
    add('defrost_finished', {});
  }
  if (prev.status !== 'offline' && curr.status === 'offline') {
    add('went_offline', { from: prev.status });
  }
  if (prev.status !== 'online' && curr.status === 'online') {
    add('came_online', { from: prev.status });
  }

  return events;
};
