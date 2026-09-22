import { describe, expect, it } from 'vitest';
import { EXPERIMENT_NAMES, isExperimentName } from '../src/experiment.js';

import { EXPERIMENTS } from '../src/experiments/index.js';
import { isLabName, labName, parseBrokers } from '../src/lab.js';
import { formatDuration } from '../src/report.js';

describe('реестр опытов', () => {
  it('содержит все восемь имён, и имя опыта совпадает с ключом реестра', () => {
    expect(EXPERIMENT_NAMES).toHaveLength(8);
    for (const name of EXPERIMENT_NAMES) {
      expect(EXPERIMENTS[name].name).toBe(name);
      expect(EXPERIMENTS[name].title.length).toBeGreaterThan(0);
    }
  });

  it('отличает имя опыта от постороннего аргумента', () => {
    expect(isExperimentName('order')).toBe(true);
    expect(isExperimentName('fieldstream.telemetry.raw.v1')).toBe(false);
  });

  it('у каждого опыта свой заголовок и свой прогон', () => {
    const titles = new Set<string>();

    for (const name of EXPERIMENT_NAMES) {
      expect(typeof EXPERIMENTS[name].run).toBe('function');
      titles.add(EXPERIMENTS[name].title);
    }

    expect(titles.size).toBe(EXPERIMENT_NAMES.length);
  });
});

describe('учебные имена', () => {
  it('складывает имя из префикса, опыта и суффикса', () => {
    expect(labName('order', 'input')).toBe('fieldstream.lab.order.input');
    expect(() => labName('order', ' ')).toThrow(/суффикс/);
  });

  it('не признаёт боевой топик стенда учебным', () => {
    expect(isLabName('fieldstream.lab.dlq.retry')).toBe(true);
    expect(isLabName('fieldstream.telemetry.raw.v1')).toBe(false);
  });
});

describe('адреса брокеров', () => {
  it('берёт умолчание, когда переменная пуста', () => {
    expect(parseBrokers(undefined)).toEqual(['localhost:29092']);
    expect(parseBrokers('  ')).toEqual(['localhost:29092']);
  });

  it('разбирает список через запятую', () => {
    expect(parseBrokers('localhost:29092, kafka:9092')).toEqual(['localhost:29092', 'kafka:9092']);
  });
});

describe('длительность в протоколе', () => {
  it('пишется словами', () => {
    expect(formatDuration(840)).toBe('840 мс');
    expect(formatDuration(4_240)).toBe('4.2 с');
    expect(formatDuration(80_000)).toBe('1 мин 20 с');
  });
});
