import { describe, expect, it } from 'vitest';
import type { DeviceProfile, RawBlock } from '@fieldstream/contracts';
import type { DecodedValue } from '@fieldstream/modbus-codec';
import { profileByVersion } from './catalog.js';
import { decodeFrame } from './decode-frame.js';
import { buildDeviceReadPlan } from './read-plan.js';
import {
  buildSimulationValues,
  encodeSimulationRegisters,
  readSimulatedBlock,
} from './simulation.js';
import { pm3PhaseProfile } from './profiles/pm-3phase.js';
import { rc2000Profile } from './profiles/rc-2000.js';

/** Кадр прибора, прочитанный по плану из регистров с заданными значениями. */
const frameOf = (profile: DeviceProfile, values: ReadonlyMap<string, DecodedValue>): RawBlock[] => {
  const registers = encodeSimulationRegisters(profile, values);
  return buildDeviceReadPlan(profile).blocks.map((block) => ({
    registerType: block.registerType,
    startAddress: block.startAddress,
    words: readSimulatedBlock(registers, block),
  }));
};

describe('разбор сырого кадра', () => {
  it('измерения возвращаются числами ровно такими, какими их записали', () => {
    const values = buildSimulationValues(pm3PhaseProfile, 42);
    const metrics = decodeFrame(pm3PhaseProfile, frameOf(pm3PhaseProfile, values));

    expect(metrics).toHaveLength(9);
    for (const metric of metrics) {
      expect(metric.value).toBe(values.get(metric.key));
      expect(metric.decoded).toBe(values.get(metric.key));
    }
  });

  it('перечисление хранится кодом, а смысл остаётся меткой', () => {
    const values = new Map<string, DecodedValue>([
      ['compressor_state', 'running'],
      ['door_open', 'open'],
      ['supply_temp_c', -18.4],
    ]);
    const metrics = new Map(
      decodeFrame(rc2000Profile, frameOf(rc2000Profile, values)).map((metric) => [
        metric.key,
        metric,
      ]),
    );

    expect(metrics.get('compressor_state')).toEqual({
      key: 'compressor_state',
      value: 2,
      decoded: 'running',
    });
    expect(metrics.get('door_open')).toEqual({ key: 'door_open', value: 1, decoded: 'open' });
    expect(metrics.get('supply_temp_c')).toEqual({
      key: 'supply_temp_c',
      value: -18.4,
      decoded: -18.4,
    });
  });

  it('слово аварий хранится словом, а смысл флагами с учётом инверсии', () => {
    const flags = {
      high_temp: true,
      low_temp: false,
      probe_fault: false,
      hp_switch: false,
      lp_switch: false,
      door_alarm: true,
      defrost_timeout: false,
      panel_link_ok: true,
    };
    const metric = decodeFrame(
      rc2000Profile,
      frameOf(rc2000Profile, new Map<string, DecodedValue>([['alarm_bits', flags]])),
    ).find((candidate) => candidate.key === 'alarm_bits');

    expect(metric?.value).toBe(0b0010_0001);
    expect(metric?.decoded).toEqual(flags);
  });

  it('параметр вне блоков кадра пропускается, а не выдумывается', () => {
    const frame = frameOf(rc2000Profile, buildSimulationValues(rc2000Profile, 1)).filter(
      (block) => block.registerType === 'input',
    );

    expect(decodeFrame(rc2000Profile, frame).map((metric) => metric.key)).not.toContain(
      'setpoint_c',
    );
  });

  it('профиль ищется строго по версии кадра', () => {
    expect(profileByVersion('rc-2000', 1)).toBe(rc2000Profile);
    expect(profileByVersion('rc-2000', 2)).toBeUndefined();
    expect(profileByVersion('нет-такой', 1)).toBeUndefined();
  });
});
