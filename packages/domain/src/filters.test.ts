import { describe, expect, it } from 'vitest';
import type { SpikeFilterConfig, SpikeFilterState } from './filters.js';
import { idleSpikeFilterState, spikeFilter } from './filters.js';

const CONFIG: SpikeFilterConfig = { maxDelta: 5, acceptAfter: 3 };

/** Прогоняет серию значений через фильтр и отдаёт то, что вышло наружу. */
const run = (
  values: readonly (number | null)[],
  config: SpikeFilterConfig = CONFIG,
): { values: (number | null)[]; rejected: boolean[]; state: SpikeFilterState } => {
  let state = idleSpikeFilterState();
  const out: (number | null)[] = [];
  const rejected: boolean[] = [];

  for (const value of values) {
    const result = spikeFilter(state, value, config);
    state = result.state;
    out.push(result.value);
    rejected.push(result.rejected);
  }

  return { values: out, rejected, state };
};

describe('spikeFilter', () => {
  it('первое значение принимается без сравнения', () => {
    const result = spikeFilter(idleSpikeFilterState(), -18, CONFIG);

    expect(result).toEqual({
      value: -18,
      rejected: false,
      state: { accepted: -18, candidate: null, candidateCycles: 0 },
    });
  });

  it('изменение внутри maxDelta принимается, граница включительно', () => {
    expect(run([-18, -14, -19]).values).toEqual([-18, -14, -19]);
    expect(run([0, 5]).rejected).toEqual([false, false]);
  });

  it('одиночный выброс отбрасывается, наружу идёт последнее принятое', () => {
    const result = run([-18, 120, -17]);

    expect(result.values).toEqual([-18, -18, -17]);
    expect(result.rejected).toEqual([false, true, false]);
    expect(result.state.accepted).toBe(-17);
  });

  it('новый уровень принимается после acceptAfter подтверждений подряд', () => {
    const result = run([-18, 40, 41, 42, 43]);

    expect(result.values).toEqual([-18, -18, -18, 42, 43]);
    expect(result.rejected).toEqual([false, true, true, false, false]);
  });

  it('возврат к прежнему уровню сбрасывает копившееся подтверждение', () => {
    const result = run([-18, 40, 41, -18, 40, 41]);

    expect(result.values).toEqual([-18, -18, -18, -18, -18, -18]);
    expect(result.state.candidateCycles).toBe(2);
  });

  it('другой кандидат начинает подтверждение заново', () => {
    const result = run([0, 50, 51, 200]);

    expect(result.rejected).toEqual([false, true, true, true]);
    expect(result.state).toEqual({ accepted: 0, candidate: 200, candidateCycles: 1 });
  });

  it('acceptAfter равный единице принимает скачок сразу', () => {
    const result = run([0, 100], { maxDelta: 5, acceptAfter: 1 });

    expect(result.values).toEqual([0, 100]);
    expect(result.rejected).toEqual([false, false]);
  });

  it('пропуск значения не считается выбросом и не трогает состояние', () => {
    const before: SpikeFilterState = { accepted: -18, candidate: 40, candidateCycles: 1 };
    const result = spikeFilter(before, null, CONFIG);

    expect(result).toEqual({ value: null, rejected: false, state: before });
  });

  it('входное состояние не мутируется', () => {
    const before: SpikeFilterState = { accepted: -18, candidate: null, candidateCycles: 0 };
    const copy = { ...before };

    const result = spikeFilter(before, 120, CONFIG);

    expect(before).toEqual(copy);
    expect(result.state).not.toBe(before);
  });
});
