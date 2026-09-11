import { describe, expect, it } from 'vitest';
import { listPlanEntries, pm3PhaseProfile } from '@fieldstream/device-profiles';
import { METER, initialMeter, meterValues, stepMeter } from './meter.js';
import type { MeterInputs, MeterState } from './meter.js';
import { createRandom } from './random.js';

const IDLE: MeterInputs = {
  compressor: 'stopped',
  heating: false,
  activity: 0,
  hour: 3,
  powerDip: false,
};

/** Прогон счётчика по секунде при неизменной нагрузке. */
const run = (state: MeterState, inputs: MeterInputs, seconds: number): MeterState => {
  let current = state;
  for (let second = 0; second < seconds; second += 1) current = stepMeter(current, inputs, 1);
  return current;
};

const numberAt = (state: MeterState, key: string): number => {
  const value = meterValues(state).get(key);
  if (typeof value !== 'number') throw new Error(`ожидалось число в "${key}"`);
  return value;
};

const RUNNING: MeterInputs = { ...IDLE, compressor: 'running' };

describe('модель счётчика', () => {
  it('мощность выходит на нагрузку работающего компрессора', () => {
    const state = run(initialMeter(createRandom(1)), RUNNING, 60);

    expect(state.powerKw).toBeCloseTo(METER.baseKw + 11, 1);
  });

  it('энергия копится по мощности: час при 12.5 кВт даёт 12.5 кВт·ч', () => {
    const warm = run(initialMeter(createRandom(2)), RUNNING, 60);
    const hourLater = run(warm, RUNNING, 3600);

    expect(hourLater.energyKwh - warm.energyKwh).toBeCloseTo(12.5, 1);
  });

  it('ток фаз сходится с мощностью: P = U·I·cosφ по трём фазам', () => {
    const state = run(initialMeter(createRandom(3)), RUNNING, 60);
    const phases = [1, 2, 3].map(
      (phase) =>
        numberAt(state, `voltage_l${String(phase)}_v`) *
        numberAt(state, `current_l${String(phase)}_a`) *
        state.powerFactor,
    );
    const total = phases.reduce((sum, value) => sum + value, 0);

    expect(Math.abs(total / (state.powerKw * 1000) - 1)).toBeLessThan(0.05);
  });

  it('провал напряжения уводит все три фазы ниже 200 В', () => {
    const state = run(initialMeter(createRandom(4)), { ...IDLE, powerDip: true }, 30);

    for (const voltage of state.voltagesV) expect(voltage).toBeLessThan(200);
  });

  it('показания покрывают ровно параметры профиля pm-3phase', () => {
    const keys = [...meterValues(initialMeter(createRandom(5))).keys()].sort();
    const profileKeys = listPlanEntries(pm3PhaseProfile)
      .map((entry) => entry.param.key)
      .sort();

    expect(keys).toEqual(profileKeys);
  });
});
