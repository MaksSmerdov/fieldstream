import { describe, expect, it } from 'vitest';
import { DEMO_STAND, listPlanEntries, profileByKey } from '@fieldstream/device-profiles';
import { createFakeClock } from '@fieldstream/domain';
import type { FakeClock } from '@fieldstream/domain';
import type { DecodedValue } from '@fieldstream/modbus-codec';
import { createWorld } from './world.js';
import type { PhysicsFaults, World } from './world.js';

const START = Date.parse('2026-09-11T00:00:00Z');
const POLL_MS = 10_000;
const NO_FAULTS: PhysicsFaults = { doorStuck: () => false, powerDip: () => false };

const makeWorld = (
  seed = 'world-test',
  faults: PhysicsFaults = NO_FAULTS,
): { clock: FakeClock; world: World } => {
  const clock = createFakeClock(START);
  return { clock, world: createWorld({ stand: DEMO_STAND, seed, clock, speed: 1, faults }) };
};

const snapshot = (world: World): Record<string, Record<string, DecodedValue>> =>
  Object.fromEntries(
    DEMO_STAND.devices.map((device) => [
      device.code,
      Object.fromEntries(world.values(device.code) ?? []),
    ]),
  );

describe('мир стенда', () => {
  it('один сид даёт одну и ту же историю, другой сид другую', () => {
    const first = makeWorld('alpha');
    const second = makeWorld('alpha');
    const other = makeWorld('bravo');

    for (const pair of [first, second, other]) pair.clock.advance(3_600_000);

    expect(snapshot(first.world)).toEqual(snapshot(second.world));
    expect(snapshot(first.world)).not.toEqual(snapshot(other.world));
  });

  it('между двумя опросами значения меняются меньше порога фильтра скачков и не выходят за шкалу', () => {
    const { clock, world } = makeWorld();
    let previous = snapshot(world);
    const jumps: string[] = [];
    const offscale: string[] = [];

    for (let poll = 0; poll < (6 * 3_600_000) / POLL_MS; poll += 1) {
      clock.advance(POLL_MS);
      const current = snapshot(world);

      for (const device of DEMO_STAND.devices) {
        const profile = profileByKey(device.profileKey);
        if (profile === undefined) continue;

        for (const { param } of listPlanEntries(profile)) {
          const before = previous[device.code]?.[param.key];
          const after = current[device.code]?.[param.key];
          if (typeof before !== 'number' || typeof after !== 'number') continue;

          if (param.maxDelta !== undefined && Math.abs(after - before) >= param.maxDelta) {
            jumps.push(`${device.code}.${param.key}: ${String(before)} -> ${String(after)}`);
          }
          if (param.range !== undefined && (after < param.range.min || after > param.range.max)) {
            offscale.push(`${device.code}.${param.key}: ${String(after)}`);
          }
          if (param.range?.monotonic === true && after < before) {
            jumps.push(`${device.code}.${param.key} уменьшился`);
          }
        }
      }

      previous = current;
    }

    expect(jumps).toEqual([]);
    expect(offscale).toEqual([]);
  });

  it('оттайка в каждой камере наступает примерно раз в сорок минут', () => {
    const { clock, world } = makeWorld();
    const chambers = DEMO_STAND.devices.filter((device) => device.profileKey === 'rc-2000');
    const starts = new Map(chambers.map((device) => [device.code, 0]));
    const previous = new Map<string, DecodedValue>();

    for (let poll = 0; poll < (3 * 3_600_000) / POLL_MS; poll += 1) {
      clock.advance(POLL_MS);
      for (const device of chambers) {
        const state = world.values(device.code)?.get('defrost_state');
        if (state === 'heating' && previous.get(device.code) !== 'heating') {
          starts.set(device.code, (starts.get(device.code) ?? 0) + 1);
        }
        previous.set(device.code, state ?? null);
      }
    }

    for (const count of starts.values()) {
      expect(count).toBeGreaterThanOrEqual(2);
      expect(count).toBeLessThanOrEqual(5);
    }
  });

  it('ускорение сжимает модельное время', () => {
    const { clock, world } = makeWorld();
    world.setSpeed(60);
    clock.advance(1000);

    expect(world.simNow()).toBe(START + 60_000);
    expect(world.speed()).toBe(60);
  });

  it('оттайка по команде запускается только у камеры', () => {
    const { world } = makeWorld();

    expect(world.startDefrost('RC-101')).toBe(true);
    expect(world.values('RC-101')?.get('defrost_state')).toBe('heating');
    expect(world.startDefrost('PM-201')).toBe(false);
  });

  it('залипшая дверь из журнала поломок видна в показаниях камеры', () => {
    const { clock, world } = makeWorld('door', {
      doorStuck: (code) => code === 'RC-104',
      powerDip: () => false,
    });
    clock.advance(10_000);

    expect(world.values('RC-104')?.get('door_open')).toBe('open');
  });
});
