import { describe, expect, it } from 'vitest';
import { listPlanEntries, rc2000Profile } from '@fieldstream/device-profiles';
import { CHAMBER, chamberValues, initialChamber, startDefrost, stepChamber } from './chamber.js';
import type { ChamberInputs, ChamberState } from './chamber.js';
import { createRandom } from './random.js';
import type { Random } from './random.js';

const doorNeverOpens: Random = { next: () => 0.999 };
const NIGHT: ChamberInputs = { ambientC: 20, activity: 0, doorStuck: false, powerDip: false };

/** Прогон модели по секунде с записью каждого шага. */
const run = (
  state: ChamberState,
  inputs: ChamberInputs,
  seconds: number,
  random: Random = doorNeverOpens,
): ChamberState[] => {
  const trace: ChamberState[] = [];
  let current = state;

  for (let second = 0; second < seconds; second += 1) {
    current = stepChamber(current, inputs, 1, random);
    trace.push(current);
  }

  return trace;
};

const lastOf = (trace: readonly ChamberState[]): ChamberState => {
  const last = trace[trace.length - 1];
  if (last === undefined) throw new Error('пустой прогон');
  return last;
};

/** Камера без оттайки по расписанию, вышедшая на установившийся режим. */
const settled = (): ChamberState => {
  const start = { ...initialChamber(createRandom(1)), nextDefrostSec: Number.POSITIVE_INFINITY };
  return lastOf(run(start, NIGHT, 1800));
};

describe('модель камеры', () => {
  it('держит воздух у уставки в пределах гистерезиса', () => {
    const start = settled();
    const trace = run(start, NIGHT, 7200);
    const starts = trace.filter(
      (state, index) =>
        state.compressor === 'starting' && trace[index - 1]?.compressor === 'stopped',
    );

    for (const state of trace) {
      expect(Math.abs(state.airC - start.setpointC)).toBeLessThan(CHAMBER.hysteresisK + 0.5);
    }
    expect(starts.length).toBeGreaterThanOrEqual(3);
  });

  it('компрессор не пускается раньше защитной паузы после остановки', () => {
    const trace = run(settled(), NIGHT, 7200);

    trace.forEach((state, index) => {
      const previous = trace[index - 1];
      if (previous?.compressor !== 'stopped' || state.compressor !== 'starting') return;
      expect(previous.compressorSec + 1).toBeGreaterThanOrEqual(CHAMBER.minOffSec);
    });
  });

  it('оттайка поднимает воздух на 6 и более градусов и завершается сама', () => {
    const start = startDefrost(settled());
    const trace = run(start, NIGHT, CHAMBER.heatingSec + CHAMBER.drainingSec + 60);
    const peak = Math.max(...trace.map((state) => state.airC));

    expect(peak - start.airC).toBeGreaterThanOrEqual(6);
    expect(trace.some((state) => state.defrost === 'draining')).toBe(true);
    expect(lastOf(trace).defrost).toBe('idle');
    expect(
      trace.filter((state) => state.defrost === 'heating' && state.compressor === 'running'),
    ).toEqual([]);
  });

  it('оттайка приходит по расписанию и заново взводит интервал', () => {
    const start = { ...settled(), nextDefrostSec: 10 };
    const state = lastOf(run(start, NIGHT, 11));

    expect(state.defrost).toBe('heating');
    expect(state.nextDefrostSec).toBe(CHAMBER.defrostIntervalSec);
  });

  it('провал напряжения выбивает работающий компрессор сразу', () => {
    const running: ChamberState = { ...settled(), compressor: 'running', compressorSec: 120 };
    const [state] = run(running, { ...NIGHT, powerDip: true }, 1);

    expect(state?.compressor).toBe('stopped');
    expect(state?.compressorSec).toBe(0);
  });

  it('залипшая дверь через три минуты поднимает бит door_alarm', () => {
    const trace = run(settled(), { ...NIGHT, doorStuck: true }, 200);
    const bitsAt = (second: number): unknown => {
      const state = trace[second - 1];
      return state === undefined ? undefined : chamberValues(state).get('alarm_bits');
    };

    expect(lastOf(trace).doorOpen).toBe(true);
    expect(bitsAt(100)).toMatchObject({ door_alarm: false });
    expect(bitsAt(200)).toMatchObject({ door_alarm: true });
  });

  it('показания покрывают ровно параметры профиля rc-2000', () => {
    const keys = [...chamberValues(settled()).keys()].sort();
    const profileKeys = listPlanEntries(rc2000Profile)
      .map((entry) => entry.param.key)
      .sort();

    expect(keys).toEqual(profileKeys);
  });
});
