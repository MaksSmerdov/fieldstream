import { describe, expect, it } from 'vitest';
import { neededResources, selectMeasures } from '../src/bench.js';
import { MEASURE_NAMES, isMeasureName } from '../src/measure.js';
import { MEASURES } from '../src/measures/index.js';

describe('реестр замеров', () => {
  it('содержит все восемь имён, и имя замера совпадает с ключом реестра', () => {
    expect(MEASURE_NAMES).toHaveLength(8);
    for (const name of MEASURE_NAMES) {
      expect(MEASURES[name].name).toBe(name);
      expect(MEASURES[name].title.length).toBeGreaterThan(0);
      expect(MEASURES[name].needs.length).toBeGreaterThan(0);
    }
  });

  it('отличает имя замера от постороннего аргумента', () => {
    expect(isMeasureName('throughput')).toBe(true);
    expect(isMeasureName('--load')).toBe(false);
  });

  it('у каждого замера свой заголовок и свой прогон', () => {
    const titles = new Set(MEASURE_NAMES.map((name) => MEASURES[name].title));

    expect(titles.size).toBe(MEASURE_NAMES.length);
    for (const name of MEASURE_NAMES) expect(typeof MEASURES[name].run).toBe('function');
  });
});

describe('выбор замеров', () => {
  it('без имён идут все восемь в порядке реестра', () => {
    expect(selectMeasures([]).map((measure) => measure.name)).toEqual([...MEASURE_NAMES]);
  });

  it('названные идут в том порядке, в каком названы', () => {
    expect(selectMeasures(['volumes', 'images']).map((measure) => measure.name)).toEqual([
      'volumes',
      'images',
    ]);
  });
});

describe('нужды прогона', () => {
  it('замерам по docker база не нужна', () => {
    expect([...neededResources(selectMeasures(['images', 'memory']), false)]).toEqual(['docker']);
  });

  it('замеру по базе нужен ещё и docker: порт базы наружу не опубликован', () => {
    const needed = neededResources(selectMeasures(['throughput']), false);

    expect(needed.has('db')).toBe(true);
    expect(needed.has('docker')).toBe(true);
  });

  it('нагрузочный режим просит шлюз даже у замеров, которым он не нужен', () => {
    expect(neededResources(selectMeasures(['images']), true).has('gateway')).toBe(true);
    expect(neededResources(selectMeasures(['images']), false).has('gateway')).toBe(false);
  });
});
