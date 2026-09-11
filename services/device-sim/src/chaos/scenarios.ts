import type { SimFaultRequestInput, SimScenarioName, Stand } from '@fieldstream/contracts';
import { rc2000Profile } from '@fieldstream/device-profiles';

/**
 * Сценарии стенда: именованные наборы поломок. Каждый воспроизводит историю,
 * которую потом показывает интерфейс или проверяет сквозной тест.
 */
export const SCENARIOS: Readonly<
  Record<SimScenarioName, (stand: Stand) => SimFaultRequestInput[]>
> = {
  'night-defrost': (stand) =>
    stand.devices
      .filter((device) => device.profileKey === rc2000Profile.profileKey)
      .map((device) => ({ targetKind: 'device', targetId: device.code, kind: 'defrost' })),
  'door-left-open': () => [
    { targetKind: 'device', targetId: 'RC-104', kind: 'door_stuck', ttlSec: 1200 },
  ],
  'line-blackout': () => [{ targetKind: 'line', targetId: 'L2', kind: 'offline', ttlSec: 180 }],
  'power-dip': () => [{ targetKind: 'line', targetId: 'L3', kind: 'power_dip', ttlSec: 60 }],
};
