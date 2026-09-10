import { describe, expect, it } from 'vitest';
import { decodeParam } from '@fieldstream/modbus-codec';
import type { DecodedValue } from '@fieldstream/modbus-codec';
import type { DeviceProfile } from '@fieldstream/contracts';
import { buildDeviceReadPlan, listPlanEntries, paramWordsInBlock } from './read-plan.js';
import {
  buildSimulationRegisters,
  buildSimulationValues,
  readSimulatedBlock,
} from './simulation.js';
import { rc2000Profile } from './profiles/rc-2000.js';
import { pm3PhaseProfile } from './profiles/pm-3phase.js';

const PROFILES: readonly DeviceProfile[] = [rc2000Profile, pm3PhaseProfile];

const numberAt = (values: ReadonlyMap<string, DecodedValue>, key: string): number => {
  const value = values.get(key);
  if (typeof value !== 'number') throw new Error(`ожидалось число в "${key}"`);
  return value;
};

describe('buildSimulationValues', () => {
  it('одинаковый seed даёт одинаковые значения, разный даёт разные', () => {
    for (const profile of PROFILES) {
      expect(Object.fromEntries(buildSimulationValues(profile, 42))).toEqual(
        Object.fromEntries(buildSimulationValues(profile, 42)),
      );
      expect(Object.fromEntries(buildSimulationValues(profile, 42))).not.toEqual(
        Object.fromEntries(buildSimulationValues(profile, 43)),
      );
    }
  });

  it('шаг между соседними seed заведомо меньше maxDelta параметра', () => {
    for (const profile of PROFILES) {
      const params = listPlanEntries(profile).map((entry) => entry.param);
      let previous = buildSimulationValues(profile, 0);

      for (let seed = 1; seed <= 300; seed += 1) {
        const current = buildSimulationValues(profile, seed);

        for (const param of params) {
          const before = previous.get(param.key);
          const after = current.get(param.key);
          if (param.maxDelta === undefined) continue;
          if (typeof before !== 'number' || typeof after !== 'number') continue;

          expect(Math.abs(after - before)).toBeLessThan(param.maxDelta);
        }

        previous = current;
      }
    }
  });

  it('счётчик энергии только растёт', () => {
    let previous = numberAt(buildSimulationValues(pm3PhaseProfile, 0), 'energy_kwh');

    for (let seed = 1; seed <= 500; seed += 1) {
      const current = numberAt(buildSimulationValues(pm3PhaseProfile, seed), 'energy_kwh');

      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
  });

  it('значения не выходят за инженерный диапазон профиля', () => {
    for (const profile of PROFILES) {
      for (const entry of listPlanEntries(profile)) {
        const range = entry.param.range;
        if (range === undefined) continue;

        for (const seed of [0, 17, 133, 999]) {
          const value = numberAt(buildSimulationValues(profile, seed), entry.param.key);

          expect(value).toBeGreaterThanOrEqual(range.min);
          expect(value).toBeLessThanOrEqual(range.max);
        }
      }
    }
  });

  it('слово аварий переключается редко и почти всегда спокойно', () => {
    let flips = 0;
    let raised = 0;
    let previous = JSON.stringify(buildSimulationValues(rc2000Profile, 0).get('alarm_bits'));

    for (let seed = 1; seed <= 1000; seed += 1) {
      const flags = buildSimulationValues(rc2000Profile, seed).get('alarm_bits');
      const current = JSON.stringify(flags);
      if (current !== previous) flips += 1;
      if (flags !== null && typeof flags === 'object' && flags['high_temp'] === true) raised += 1;
      previous = current;
    }

    expect(flips).toBeGreaterThan(0);
    expect(flips).toBeLessThan(100);
    expect(raised).toBeLessThan(300);
  });

  it('код состояния держится десятками циклов, а не дёргается каждый опрос', () => {
    let flips = 0;
    let previous = buildSimulationValues(rc2000Profile, 0).get('compressor_state');

    for (let seed = 1; seed <= 1000; seed += 1) {
      const current = buildSimulationValues(rc2000Profile, seed).get('compressor_state');
      if (current !== previous) flips += 1;
      previous = current;
    }

    expect(typeof previous).toBe('string');
    expect(flips).toBeGreaterThan(0);
    expect(flips).toBeLessThan(50);
  });
});

describe('buildSimulationRegisters', () => {
  it('регистры лежат в границах 16-битного слова', () => {
    for (const profile of PROFILES) {
      const registers = buildSimulationRegisters(profile, 123);

      for (const word of [...registers.holding.values(), ...registers.input.values()]) {
        expect(Number.isInteger(word)).toBe(true);
        expect(word).toBeGreaterThanOrEqual(0);
        expect(word).toBeLessThanOrEqual(0xffff);
      }
    }
  });

  it('каждый параметр реально закодирован: ни одного пустого адреса', () => {
    for (const profile of PROFILES) {
      const registers = buildSimulationRegisters(profile, 5);

      for (const entry of listPlanEntries(profile)) {
        const source = entry.registerType === 'holding' ? registers.holding : registers.input;

        for (let address = entry.start; address <= entry.end; address += 1) {
          expect(source.has(address)).toBe(true);
        }
      }
    }
  });

  it('разбор регистров возвращает ровно те значения, что задал симулятор', () => {
    for (const profile of PROFILES) {
      const plan = buildDeviceReadPlan(profile);
      const params = new Map(
        listPlanEntries(profile).map((entry) => [entry.param.key, entry.param]),
      );

      for (const seed of [0, 1, 64, 777]) {
        const registers = buildSimulationRegisters(profile, seed);
        const expected = buildSimulationValues(profile, seed);

        for (const block of plan.blocks) {
          const words = readSimulatedBlock(registers, block);

          for (const key of block.paramKeys) {
            const param = params.get(key);
            if (param === undefined) continue;

            expect(decodeParam(paramWordsInBlock(block, words, param), param)).toEqual(
              expected.get(key),
            );
          }
        }
      }
    }
  });
});

describe('readSimulatedBlock', () => {
  it('регистр внутри объявленного блока, не занятый параметром, читается нулём', () => {
    const registers = buildSimulationRegisters(pm3PhaseProfile, 3);
    const block = buildDeviceReadPlan(pm3PhaseProfile).blocks.find((item) => item.id === 'mains');

    expect(block).toBeDefined();
    if (block === undefined) return;

    expect(readSimulatedBlock(registers, block)).toHaveLength(10);
    expect(readSimulatedBlock(registers, block)[3]).toBe(0);
  });
});
