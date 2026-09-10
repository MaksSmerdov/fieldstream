import type { DeviceProfile } from '@fieldstream/contracts';
import { PM3PHASE_DEVICE_CODES, pm3PhaseProfile } from './profiles/pm-3phase.js';
import { RC2000_DEVICE_CODES, rc2000Profile } from './profiles/rc-2000.js';

export * from './read-plan.js';
export * from './validate.js';
export * from './simulation.js';
export * from './profiles/rc-2000.js';
export * from './profiles/pm-3phase.js';

/** Все известные модели приборов. Новая модель это один файл и одна строка здесь. */
export const DEVICE_PROFILES: readonly DeviceProfile[] = Object.freeze([
  rc2000Profile,
  pm3PhaseProfile,
]);

const PROFILE_BY_DEVICE_CODE = new Map<string, DeviceProfile>([
  ...RC2000_DEVICE_CODES.map((code) => [code, rc2000Profile] as const),
  ...PM3PHASE_DEVICE_CODES.map((code) => [code, pm3PhaseProfile] as const),
]);

/** Профиль по ключу модели. */
export const profileByKey = (key: string): DeviceProfile | undefined =>
  DEVICE_PROFILES.find((profile) => profile.profileKey === key);

/** Профиль, который обслуживает прибор с этим кодом. */
export const profileForDeviceCode = (code: string): DeviceProfile | undefined =>
  PROFILE_BY_DEVICE_CODE.get(code);
