import { describe, expect, it } from 'vitest';
import { paramSpecSchema } from '@fieldstream/contracts';
import type { ByteOrder, ParamSpec } from '@fieldstream/contracts';
import { decodeParam } from './decode.js';

const makeParam = (input: Partial<ParamSpec> & Pick<ParamSpec, 'dataType'>): ParamSpec =>
  paramSpecSchema.parse({ key: 'value', label: 'Значение', address: 0, ...input });

describe('целые со знаком и без', () => {
  it('int16 читает отрицательное значение в дополнительном коде', () => {
    const param = makeParam({ dataType: 'int16', precision: 0 });
    expect(decodeParam([0xfffe], param)).toBe(-2);
    expect(decodeParam([0x8000], param)).toBe(-32768);
    expect(decodeParam([0x7fff], param)).toBe(32767);
  });

  it('uint16 не видит знака в том же слове', () => {
    const param = makeParam({ dataType: 'uint16', precision: 0 });
    expect(decodeParam([0xfffe], param)).toBe(65534);
    expect(decodeParam([0x8000], param)).toBe(32768);
  });

  it('int32 читает отрицательное значение из двух слов', () => {
    const param = makeParam({ dataType: 'int32', precision: 0 });
    expect(decodeParam([0xfffe, 0x1dc0], param)).toBe(-123456);
    expect(decodeParam([0x8000, 0x0000], param)).toBe(-2147483648);
    expect(decodeParam([0x7fff, 0xffff], param)).toBe(2147483647);
  });

  it('uint32 читает верхнюю половину диапазона', () => {
    const param = makeParam({ dataType: 'uint32', precision: 0 });
    expect(decodeParam([0xffff, 0xffff], param)).toBe(4294967295);
    expect(decodeParam([0x8000, 0x0000], param)).toBe(2147483648);
  });

  it('лишние слова после параметра игнорируются', () => {
    const param = makeParam({ dataType: 'int32', precision: 0 });
    expect(decodeParam([0x0001, 0x86a0, 0xdead, 0xbeef], param)).toBe(100000);
  });
});

describe('float32', () => {
  it('читает точно представимые значения', () => {
    const param = makeParam({ dataType: 'float32', precision: 4 });
    expect(decodeParam([0x3fc0, 0x0000], param)).toBe(1.5);
    expect(decodeParam([0xbfc0, 0x0000], param)).toBe(-1.5);
    expect(decodeParam([0x0000, 0x0000], param)).toBe(0);
  });

  it('округляет одинарную точность до precision', () => {
    const words = [0x4049, 0x0fdb];
    expect(decodeParam(words, makeParam({ dataType: 'float32', precision: 0 }))).toBe(3);
    expect(decodeParam(words, makeParam({ dataType: 'float32', precision: 2 }))).toBe(3.14);
    expect(decodeParam(words, makeParam({ dataType: 'float32', precision: 4 }))).toBe(3.1416);
    expect(decodeParam(words, makeParam({ dataType: 'float32', precision: 6 }))).toBe(3.141593);
  });

  it('нечисло и бесконечность превращаются в null, а не текут дальше', () => {
    const param = makeParam({ dataType: 'float32', precision: 2 });
    expect(decodeParam([0x7fc0, 0x0000], param)).toBeNull();
    expect(decodeParam([0x7f80, 0x0000], param)).toBeNull();
  });
});

describe('порядок слов на 32-битном счётчике', () => {
  const words: Readonly<Record<ByteOrder, readonly number[]>> = {
    ABCD: [0x0001, 0x86a0],
    DCBA: [0xa086, 0x0100],
    BADC: [0x0100, 0xa086],
    CDAB: [0x86a0, 0x0001],
  };

  for (const order of ['ABCD', 'DCBA', 'BADC', 'CDAB'] as const) {
    it(`порядок ${order} даёт то же показание счётчика`, () => {
      const param = makeParam({ dataType: 'uint32', byteOrder: order, precision: 0 });
      expect(decodeParam(words[order], param)).toBe(100000);
    });
  }

  it('слова CDAB, прочитанные как ABCD, дают совсем другое число', () => {
    const wrong = makeParam({ dataType: 'uint32', byteOrder: 'ABCD', precision: 0 });
    const right = makeParam({ dataType: 'uint32', byteOrder: 'CDAB', precision: 0 });
    expect(decodeParam(words.CDAB, wrong)).toBe(2258632705);
    expect(decodeParam(words.CDAB, right)).toBe(100000);
  });

  it('на int32 неверный порядок ещё и переворачивает знак', () => {
    const wrong = makeParam({ dataType: 'int32', byteOrder: 'ABCD', precision: 0 });
    const right = makeParam({ dataType: 'int32', byteOrder: 'CDAB', precision: 0 });
    expect(decodeParam(words.CDAB, right)).toBe(100000);
    expect(decodeParam(words.CDAB, wrong)).toBeLessThan(0);
  });
});

describe('scale, offset и precision', () => {
  it('scale 0.1 на int16 даёт десятые доли, включая отрицательные', () => {
    const param = makeParam({ dataType: 'int16', scale: 0.1, precision: 1 });
    expect(decodeParam([1234], param)).toBe(123.4);
    expect(decodeParam([0xffc9], param)).toBe(-5.5);
    expect(decodeParam([0], param)).toBe(0);
  });

  it('offset применяется после scale', () => {
    const param = makeParam({ dataType: 'uint16', scale: 0.1, offset: -273.15, precision: 2 });
    expect(decodeParam([3000], param)).toBe(26.85);
    expect(decodeParam([2731], param)).toBe(-0.05);
  });

  it('precision действительно режет знаки, а не только показывает', () => {
    const words = [0x0000, 0x0e1f];
    expect(decodeParam(words, makeParam({ dataType: 'int32', scale: 0.001, precision: 6 }))).toBe(
      3.615,
    );
    expect(decodeParam(words, makeParam({ dataType: 'int32', scale: 0.001, precision: 1 }))).toBe(
      3.6,
    );
    expect(decodeParam(words, makeParam({ dataType: 'int32', scale: 0.001, precision: 0 }))).toBe(
      4,
    );
  });

  it('минус ноль не просачивается в значение', () => {
    const param = makeParam({ dataType: 'int16', scale: 0.001, precision: 1 });
    expect(Object.is(decodeParam([0xffff], param), 0)).toBe(true);
  });
});

describe('bits16', () => {
  const allBits = Array.from({ length: 16 }, (_, index) => ({
    bit: index,
    key: `b${index}`,
    label: `Бит ${index}`,
  }));
  const allFlags = (state: boolean): Record<string, boolean> =>
    Object.fromEntries(allBits.map((spec) => [spec.key, state]));

  it('разбирает все шестнадцать битов слова состояния', () => {
    const param = makeParam({ dataType: 'bits16', bits: allBits });
    expect(decodeParam([0xa5a5], param)).toEqual({
      b0: true,
      b1: false,
      b2: true,
      b3: false,
      b4: false,
      b5: true,
      b6: false,
      b7: true,
      b8: true,
      b9: false,
      b10: true,
      b11: false,
      b12: false,
      b13: true,
      b14: false,
      b15: true,
    });
  });

  it('крайние слова дают всё включено и всё выключено', () => {
    const param = makeParam({ dataType: 'bits16', bits: allBits });
    expect(decodeParam([0xffff], param)).toEqual(allFlags(true));
    expect(decodeParam([0x0000], param)).toEqual(allFlags(false));
  });

  it('invert переворачивает смысл бита: ноль это норма', () => {
    const param = makeParam({
      dataType: 'bits16',
      bits: [
        { bit: 2, key: 'healthy', label: 'Исправен', invert: true },
        { bit: 3, key: 'door', label: 'Дверь' },
      ],
    });
    expect(decodeParam([0b0000], param)).toEqual({ healthy: true, door: false });
    expect(decodeParam([0b1100], param)).toEqual({ healthy: false, door: true });
  });

  it('неописанные биты не попадают в результат', () => {
    const param = makeParam({
      dataType: 'bits16',
      bits: [
        { bit: 0, key: 'run', label: 'Работа' },
        { bit: 3, key: 'fault', label: 'Авария' },
      ],
    });
    expect(decodeParam([0b1001], param)).toEqual({ run: true, fault: true });
    expect(decodeParam([0xfff6], param)).toEqual({ run: false, fault: false });
  });
});

describe('enum', () => {
  const param = makeParam({
    dataType: 'uint16',
    precision: 0,
    enum: { '0': 'stopped', '1': 'running', '2': 'defrost' },
  });

  it('известный код превращается в строку состояния', () => {
    expect(decodeParam([0], param)).toBe('stopped');
    expect(decodeParam([2], param)).toBe('defrost');
  });

  it('неизвестный код даёт null, а не сырое число', () => {
    expect(decodeParam([7], param)).toBeNull();
  });

  it('код ищется уже после scale и offset', () => {
    const scaled = makeParam({
      dataType: 'uint16',
      scale: 0.5,
      precision: 0,
      enum: { '1': 'running' },
    });
    expect(decodeParam([2], scaled)).toBe('running');
    expect(decodeParam([6], scaled)).toBeNull();
  });
});

describe('нехватка слов', () => {
  it('пустой массив даёт null для однословных типов', () => {
    expect(decodeParam([], makeParam({ dataType: 'int16' }))).toBeNull();
    expect(decodeParam([], makeParam({ dataType: 'uint16' }))).toBeNull();
  });

  it('одно слово даёт null для 32-битных типов', () => {
    expect(decodeParam([0x0001], makeParam({ dataType: 'int32' }))).toBeNull();
    expect(decodeParam([0x0001], makeParam({ dataType: 'uint32' }))).toBeNull();
    expect(decodeParam([0x3fc0], makeParam({ dataType: 'float32' }))).toBeNull();
  });

  it('нехватка слов не бросает исключение', () => {
    expect(() => decodeParam([], makeParam({ dataType: 'float32' }))).not.toThrow();
  });
});
