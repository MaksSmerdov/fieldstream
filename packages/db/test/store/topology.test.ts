import { describe, expect, it } from 'vitest';
import { pm3PhaseProfile, rc2000Profile } from '@fieldstream/device-profiles';
import { connectionUrl } from '../../src/setup/connection.js';
import { metricDefsOf, profileChecksum } from '../../src/store/topology.js';

describe('описания метрик', () => {
  it('вид метрики берётся из профиля: число, перечисление или слово аварий', () => {
    const kinds = Object.fromEntries(
      metricDefsOf(rc2000Profile).map((def) => [def.metricKey, def.kind]),
    );

    expect(kinds).toMatchObject({
      supply_temp_c: 'number',
      setpoint_c: 'number',
      compressor_state: 'enum',
      door_open: 'enum',
      alarm_bits: 'bits',
    });
  });

  it('у каждой метрики счётчика есть единица или явное её отсутствие', () => {
    const defs = metricDefsOf(pm3PhaseProfile);

    expect(defs).toHaveLength(9);
    expect(defs.find((def) => def.metricKey === 'energy_kwh')).toMatchObject({
      unit: 'кВт·ч',
      precision: 1,
    });
    expect(defs.find((def) => def.metricKey === 'power_factor')?.unit).toBeNull();
  });
});

describe('контрольная сумма профиля', () => {
  it('стабильна для одного описания и меняется при любой правке', () => {
    const changed = { ...rc2000Profile, label: 'Другой контроллер' };

    expect(profileChecksum(rc2000Profile)).toBe(profileChecksum(rc2000Profile));
    expect(profileChecksum(changed)).not.toBe(profileChecksum(rc2000Profile));
  });
});

describe('строка подключения', () => {
  it('экранирует спецсимволы пароля', () => {
    expect(
      connectionUrl({ host: 'db', port: 5432, database: 'fieldstream' }, 'fs_api', 'p@ss:w/rd'),
    ).toBe('postgres://fs_api:p%40ss%3Aw%2Frd@db:5432/fieldstream');
  });
});
