import type { Clock } from '@fieldstream/domain';
import type { DeviceProfile, Stand, StandDevice } from '@fieldstream/contracts';
import type { DecodedValue } from '@fieldstream/modbus-codec';
import {
  buildSimulationValues,
  listPlanEntries,
  pm3PhaseProfile,
  profileByKey,
  rc2000Profile,
} from '@fieldstream/device-profiles';
import { chamberValues, initialChamber, startDefrost, stepChamber } from './chamber.js';
import type { ChamberState } from './chamber.js';
import { activityLevel, ambientTempC, localHour } from './daily.js';
import { initialMeter, meterValues, stepMeter } from './meter.js';
import type { MeterState } from './meter.js';
import { createRandom, hashString } from './random.js';
import type { Random } from './random.js';

const STEP_MS = 1000;
const STEP_SEC = STEP_MS / 1000;
const MAX_CATCH_UP_STEPS = 86_400;
const GENERIC_PERIOD_MS = 10_000;

/** Поломки, которые меняют саму физику, а не обмен по линии. */
export interface PhysicsFaults {
  readonly doorStuck: (deviceCode: string) => boolean;
  readonly powerDip: (lineCode: string) => boolean;
}

export interface WorldOptions {
  readonly stand: Stand;
  readonly seed: string;
  readonly clock: Clock;
  readonly speed: number;
  readonly faults: PhysicsFaults;
}

/**
 * Модельный мир стенда: своё время с ускорением и физика всех приборов.
 * Физика досчитывается шагами по секунде в момент обращения, поэтому состояние
 * зависит только от сида и модельного времени, а не от того, как часто его читали.
 */
export interface World {
  readonly simNow: () => number;
  readonly speed: () => number;
  readonly setSpeed: (factor: number) => void;
  readonly values: (deviceCode: string) => Map<string, DecodedValue> | undefined;
  readonly isChamber: (deviceCode: string) => boolean;
  readonly startDefrost: (deviceCode: string) => boolean;
}

interface ChamberSlot {
  readonly device: StandDevice;
  readonly timezone: string;
  readonly random: Random;
  state: ChamberState;
}

interface MeterSlot {
  readonly device: StandDevice;
  readonly timezone: string;
  readonly feeds: ChamberSlot | undefined;
  state: MeterState;
}

interface GenericSlot {
  readonly profile: DeviceProfile;
  readonly salt: number;
}

/** Часовой пояс каждой линии: линия, её шлюз, его площадка. */
const lineTimezones = (stand: Stand): Map<string, string> => {
  const siteZone = new Map(stand.sites.map((site) => [site.code, site.timezone]));
  const gatewayZone = new Map(
    stand.gateways.map((gateway) => [gateway.code, siteZone.get(gateway.siteCode) ?? 'UTC']),
  );
  return new Map(
    stand.lines.map((line) => [line.code, gatewayZone.get(line.gatewayCode) ?? 'UTC']),
  );
};

/** Округление до точности параметра: ровно так значение вернёт декодер. */
const roundTo = (value: number, precision: number): number => {
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
};

const roundedToProfile = (
  profile: DeviceProfile,
  values: Map<string, DecodedValue>,
): Map<string, DecodedValue> => {
  for (const entry of listPlanEntries(profile)) {
    const value = values.get(entry.param.key);
    if (typeof value === 'number')
      values.set(entry.param.key, roundTo(value, entry.param.precision));
  }
  return values;
};

/** Приборы линии одной модели по порядку адресов. */
const lineDevices = (stand: Stand, lineCode: string, profileKey: string): StandDevice[] =>
  stand.devices
    .filter((device) => device.lineCode === lineCode && device.profileKey === profileKey)
    .sort((left, right) => left.slaveId - right.slaveId);

/** Создаёт мир стенда. Счётчик N-й по адресу на линии питает N-ю по адресу камеру той же линии. */
export const createWorld = (options: WorldOptions): World => {
  const { stand, clock, faults } = options;
  const zones = lineTimezones(stand);
  const startMs = clock.now();
  let anchorSimMs = startMs;
  let anchorRealMs = startMs;
  let speed = options.speed;
  let steppedMs = startMs;

  const randomFor = (code: string): Random => createRandom(hashString(`${options.seed}:${code}`));
  const profiles = new Map<string, DeviceProfile>();
  const chambers = new Map<string, ChamberSlot>();
  const meters = new Map<string, MeterSlot>();
  const generic = new Map<string, GenericSlot>();

  for (const device of stand.devices) {
    const profile = profileByKey(device.profileKey);
    if (profile === undefined) {
      throw new Error(`прибор ${device.code}: неизвестная модель ${device.profileKey}`);
    }
    profiles.set(device.code, profile);
  }

  for (const line of stand.lines) {
    const timezone = zones.get(line.code) ?? 'UTC';
    const lineChambers = lineDevices(stand, line.code, rc2000Profile.profileKey).map((device) => {
      const random = randomFor(device.code);
      const slot: ChamberSlot = { device, timezone, random, state: initialChamber(random) };
      chambers.set(device.code, slot);
      return slot;
    });

    lineDevices(stand, line.code, pm3PhaseProfile.profileKey).forEach((device, index) => {
      meters.set(device.code, {
        device,
        timezone,
        feeds: lineChambers[index],
        state: initialMeter(randomFor(device.code)),
      });
    });
  }

  for (const [code, profile] of profiles) {
    if (chambers.has(code) || meters.has(code)) continue;
    generic.set(code, { profile, salt: hashString(`${options.seed}:${code}`) % 1000 });
  }

  const step = (atMs: number): void => {
    for (const slot of chambers.values()) {
      const hour = localHour(atMs, slot.timezone);
      slot.state = stepChamber(
        slot.state,
        {
          ambientC: ambientTempC(hour),
          activity: activityLevel(hour),
          doorStuck: faults.doorStuck(slot.device.code),
          powerDip: faults.powerDip(slot.device.lineCode),
        },
        STEP_SEC,
        slot.random,
      );
    }

    for (const slot of meters.values()) {
      const hour = localHour(atMs, slot.timezone);
      const chamber = slot.feeds?.state;
      slot.state = stepMeter(
        slot.state,
        {
          compressor: chamber?.compressor ?? 'stopped',
          heating: chamber?.defrost === 'heating',
          activity: activityLevel(hour),
          hour,
          powerDip: faults.powerDip(slot.device.lineCode),
        },
        STEP_SEC,
      );
    }
  };

  const simNow = (): number => anchorSimMs + (clock.now() - anchorRealMs) * speed;

  const catchUp = (): void => {
    const target = simNow();
    let steps = Math.floor((target - steppedMs) / STEP_MS);

    if (steps > MAX_CATCH_UP_STEPS) {
      steppedMs = target - MAX_CATCH_UP_STEPS * STEP_MS;
      steps = MAX_CATCH_UP_STEPS;
    }

    for (let index = 0; index < steps; index += 1) {
      steppedMs += STEP_MS;
      step(steppedMs);
    }
  };

  const values = (deviceCode: string): Map<string, DecodedValue> | undefined => {
    const profile = profiles.get(deviceCode);
    if (profile === undefined) return undefined;
    catchUp();

    const chamber = chambers.get(deviceCode);
    if (chamber !== undefined) return roundedToProfile(profile, chamberValues(chamber.state));

    const meter = meters.get(deviceCode);
    if (meter !== undefined) return roundedToProfile(profile, meterValues(meter.state));

    const slot = generic.get(deviceCode);
    return slot === undefined
      ? undefined
      : buildSimulationValues(slot.profile, Math.floor(steppedMs / GENERIC_PERIOD_MS) + slot.salt);
  };

  return {
    simNow,
    speed: () => speed,
    setSpeed: (factor) => {
      catchUp();
      const now = simNow();
      anchorSimMs = now;
      anchorRealMs = clock.now();
      speed = factor;
    },
    values,
    isChamber: (deviceCode) => chambers.has(deviceCode),
    startDefrost: (deviceCode) => {
      const slot = chambers.get(deviceCode);
      if (slot === undefined) return false;
      catchUp();
      slot.state = startDefrost(slot.state);
      return true;
    },
  };
};
