import { describe, expect, it } from 'vitest';
import {
  bytesOf,
  formatBytes,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRate,
  formatRatio,
  numberOf,
  percentile,
} from '../src/stats.js';

describe('перцентили', () => {
  it('берут существующее значение выборки, как percentile_disc в SQL', () => {
    const values = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];

    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
    expect(percentile(values, 99)).toBe(10);
  });

  it('не зависят от порядка и не портят исходную выборку', () => {
    const values = [3, 1, 2];

    expect(percentile(values, 50)).toBe(2);
    expect(values).toEqual([3, 1, 2]);
  });

  it('на пустой выборке дают пусто, а не ноль', () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe('числа из выборки', () => {
  it('пустая ячейка и не число читаются как пусто', () => {
    expect(numberOf('2116752')).toBe(2_116_752);
    expect(numberOf('4.25')).toBe(4.25);
    expect(numberOf('')).toBeNull();
    expect(numberOf(null)).toBeNull();
    expect(numberOf('нет')).toBeNull();
  });
});

describe('форматирование чисел', () => {
  it('разряды разделяются пробелом, дробная часть остаётся целой', () => {
    expect(formatNumber(2_116_752)).toBe('2 116 752');
    expect(formatNumber(148.34, 1)).toBe('148.3');
    expect(formatNumber(999)).toBe('999');
  });

  it('доли и коэффициенты пишутся словами замера', () => {
    expect(formatPercent(0.042)).toBe('4.2 %');
    expect(formatRatio(8.37)).toBe('8.4x');
    expect(formatRate(148.34, 'строк')).toBe('148.3 строк/с');
  });
});

describe('длительность', () => {
  it('пишется словами', () => {
    expect(formatDuration(840)).toBe('840 мс');
    expect(formatDuration(4_240)).toBe('4.2 с');
    expect(formatDuration(80_000)).toBe('1 мин 20 с');
  });

  it('у коротких длительностей остаётся десятая доля миллисекунды', () => {
    expect(formatDuration(4.24)).toBe('4.2 мс');
  });
});

describe('размеры', () => {
  it('пишутся двоичными единицами', () => {
    expect(formatBytes(512)).toBe('512 Б');
    expect(formatBytes(4_812)).toBe('4.7 КиБ');
    expect(formatBytes(1_073_741_824)).toBe('1.0 ГиБ');
  });

  it('читаются из вывода docker и в десятичных, и в двоичных единицах', () => {
    expect(bytesOf('294MB')).toBe(294_000_000);
    expect(bytesOf('287.6MiB')).toBe(287.6 * 1_048_576);
    expect(bytesOf(' 0B ')).toBe(0);
    expect(bytesOf('1.2GiB')).toBe(1.2 * 1_073_741_824);
  });

  it('непонятную строку читают как пусто, а не как ноль', () => {
    expect(bytesOf('--')).toBeNull();
    expect(bytesOf('N/A')).toBeNull();
    expect(bytesOf('12 попугаев')).toBeNull();
  });
});
