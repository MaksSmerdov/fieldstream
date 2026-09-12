import { describe, expect, it } from 'vitest';
import { pm3PhaseProfile, rc2000Profile } from '@fieldstream/device-profiles';
import { INCIDENTS, wavesOf } from '../src/history.js';

describe('форма засеваемой истории', () => {
  it('берёт только числовые метрики: перечисления и слово аварий историей не рисуются', () => {
    const keys = wavesOf(rc2000Profile).map((wave) => wave.metricKey);

    expect(keys).toContain('supply_temp_c');
    expect(keys).not.toContain('compressor_state');
    expect(keys).not.toContain('alarm_bits');
  });

  /** Засев не должен выходить за шкалу прибора: иначе история выглядит сломанным датчиком. */
  it('волна укладывается в инженерный диапазон метрики', () => {
    for (const profile of [rc2000Profile, pm3PhaseProfile]) {
      for (const wave of wavesOf(profile)) {
        if (wave.monotonic) continue;
        const param = profile.sections
          .flatMap((section) => section.params)
          .find((candidate) => candidate.key === wave.metricKey);
        const range = param?.range;
        if (range === undefined) throw new Error(`у метрики ${wave.metricKey} нет диапазона`);

        expect(wave.center - wave.amplitude).toBeGreaterThanOrEqual(range.min);
        expect(wave.center + wave.amplitude).toBeLessThanOrEqual(range.max);
      }
    }
  });

  it('метрики дышат не в такт: период у каждой свой', () => {
    const periods = new Set(wavesOf(rc2000Profile).map((wave) => wave.periodSec));

    expect(periods.size).toBeGreaterThan(1);
  });

  it('происшествия заданы руками и различаются прибором, метрикой и важностью', () => {
    expect(INCIDENTS).toHaveLength(3);
    expect(new Set(INCIDENTS.map((incident) => incident.deviceCode)).size).toBe(3);
    expect(new Set(INCIDENTS.map((incident) => incident.severity)).size).toBeGreaterThan(1);

    for (const incident of INCIDENTS) {
      const beyond =
        incident.boundary === 'max'
          ? incident.value > incident.threshold
          : incident.value < incident.threshold;
      expect(beyond).toBe(true);
    }
  });
});
