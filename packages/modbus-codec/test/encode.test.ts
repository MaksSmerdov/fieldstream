import { describe, expect, it } from 'vitest';
import { WORDS_BY_DATA_TYPE, paramSpecSchema } from '@fieldstream/contracts';
import type { BitSpec, ByteOrder, DataType, ParamSpec } from '@fieldstream/contracts';
import { decodeParam } from '../src/decode.js';
import type { DecodedValue } from '../src/decode.js';
import { encodeParam } from '../src/encode.js';

const ORDERS: readonly ByteOrder[] = ['ABCD', 'DCBA', 'BADC', 'CDAB'];
const DATA_TYPES: readonly DataType[] = ['int16', 'uint16', 'int32', 'uint32', 'float32', 'bits16'];

const STATUS_BITS: readonly BitSpec[] = [
  { bit: 0, key: 'run', label: 'Работа' },
  { bit: 5, key: 'defrost', label: 'Оттайка' },
  { bit: 15, key: 'fault', label: 'Авария' },
];

const STATUS_ENUM: Readonly<Record<string, string>> = {
  '0': 'stopped',
  '1': 'running',
  '2': 'defrost',
};

const makeParam = (input: Partial<ParamSpec> & Pick<ParamSpec, 'dataType'>): ParamSpec =>
  paramSpecSchema.parse({ key: 'value', label: 'Значение', address: 0, ...input });

/** Параметр матрицы round-trip: bits16 требует описания битов, float32 читается с двумя знаками. */
const matrixParam = (dataType: DataType, byteOrder: ByteOrder): ParamSpec =>
  dataType === 'bits16'
    ? makeParam({ dataType, byteOrder, precision: 0, bits: [...STATUS_BITS] })
    : makeParam({ dataType, byteOrder, precision: dataType === 'float32' ? 2 : 0 });

const SAMPLES: Readonly<Record<DataType, readonly DecodedValue[]>> = {
  int16: [-32768, -1234, -1, 0, 1234, 32767],
  uint16: [0, 1, 4095, 65535],
  int32: [-2147483648, -123456, -1, 0, 100000, 2147483647],
  uint32: [0, 1, 100000, 4294967295],
  float32: [0, 1.5, -1.5, 3.14, -18.35, 1234.5],
  bits16: [
    { run: false, defrost: false, fault: false },
    { run: true, defrost: false, fault: false },
    { run: true, defrost: true, fault: true },
    { run: false, defrost: false, fault: true },
  ],
};

describe('round-trip по всем сочетаниям типа и порядка байт', () => {
  for (const dataType of DATA_TYPES) {
    for (const byteOrder of ORDERS) {
      it(`${dataType} и ${byteOrder} возвращают исходное значение`, () => {
        const param = matrixParam(dataType, byteOrder);
        for (const sample of SAMPLES[dataType]) {
          const words = encodeParam(sample, param);
          expect(words).toHaveLength(WORDS_BY_DATA_TYPE[dataType]);
          for (const word of words) {
            expect(word).toBeGreaterThanOrEqual(0);
            expect(word).toBeLessThanOrEqual(0xffff);
          }
          expect(decodeParam(words, param)).toEqual(sample);
        }
      });
    }
  }

  it('сырые слова прибора переживают разбор и обратную сборку', () => {
    const param = makeParam({ dataType: 'int16', scale: 0.1, precision: 1 });
    const raw = [0xffc9];
    expect(encodeParam(decodeParam(raw, param), param)).toEqual(raw);
  });
});

describe('знаковые значения', () => {
  it('int16 уходит в дополнительный код', () => {
    const param = makeParam({ dataType: 'int16', precision: 0 });
    expect(encodeParam(-2, param)).toEqual([0xfffe]);
    expect(encodeParam(-32768, param)).toEqual([0x8000]);
    expect(encodeParam(32767, param)).toEqual([0x7fff]);
  });

  it('int32 раскладывается на два слова со знаком в старшем', () => {
    const param = makeParam({ dataType: 'int32', precision: 0 });
    expect(encodeParam(-123456, param)).toEqual([0xfffe, 0x1dc0]);
    expect(encodeParam(-2147483648, param)).toEqual([0x8000, 0x0000]);
    expect(encodeParam(100000, param)).toEqual([0x0001, 0x86a0]);
  });
});

describe('float32', () => {
  it('точно представимые значения дают известные слова', () => {
    const param = makeParam({ dataType: 'float32', precision: 2 });
    expect(encodeParam(1.5, param)).toEqual([0x3fc0, 0x0000]);
    expect(encodeParam(-1.5, param)).toEqual([0xbfc0, 0x0000]);
  });

  it('одинарная точность теряет знаки, precision это скрывает', () => {
    const param = makeParam({ dataType: 'float32', precision: 3 });
    const words = encodeParam(1234.567, param);
    expect(decodeParam(words, param)).toBe(1234.567);
    expect(decodeParam(words, makeParam({ dataType: 'float32', precision: 6 }))).toBe(1234.567017);
  });
});

describe('порядок слов на 32-битном счётчике', () => {
  const abcd = makeParam({ dataType: 'uint32', byteOrder: 'ABCD', precision: 0 });
  const cdab = makeParam({ dataType: 'uint32', byteOrder: 'CDAB', precision: 0 });

  it('CDAB кладёт младшую половину счётчика в первое слово', () => {
    expect(encodeParam(100000, abcd)).toEqual([0x0001, 0x86a0]);
    expect(encodeParam(100000, cdab)).toEqual([0x86a0, 0x0001]);
  });

  it('симулятор с CDAB и обработчик с ABCD расходятся в показаниях', () => {
    const words = encodeParam(100000, cdab);
    expect(decodeParam(words, cdab)).toBe(100000);
    expect(decodeParam(words, abcd)).not.toBe(100000);
  });

  it('каждый порядок даёт свои слова для одного и того же счётчика', () => {
    const layouts = ORDERS.map((byteOrder) =>
      encodeParam(100000, makeParam({ dataType: 'uint32', byteOrder, precision: 0 })).join('.'),
    );
    expect(new Set(layouts).size).toBe(4);
  });
});

describe('scale и offset', () => {
  it('scale 0.1 на int16 возвращает исходные слова', () => {
    const param = makeParam({ dataType: 'int16', scale: 0.1, precision: 1 });
    expect(encodeParam(123.4, param)).toEqual([1234]);
    expect(encodeParam(-5.5, param)).toEqual([0xffc9]);
  });

  it('offset снимается перед делением на scale', () => {
    const param = makeParam({ dataType: 'uint16', scale: 0.1, offset: -273.15, precision: 2 });
    expect(encodeParam(26.85, param)).toEqual([3000]);
    expect(decodeParam([3000], param)).toBe(26.85);
  });

  it('значение точнее сетки scale прижимается к ближайшему слову', () => {
    const param = makeParam({ dataType: 'int16', scale: 0.1, precision: 1 });
    expect(encodeParam(123.44, param)).toEqual([1234]);
    expect(encodeParam(123.46, param)).toEqual([1235]);
  });

  it('нулевой scale не даёт восстановить сырое слово', () => {
    expect(encodeParam(10, makeParam({ dataType: 'uint16', scale: 0 }))).toEqual([]);
  });
});

describe('enum', () => {
  const param = makeParam({ dataType: 'uint16', precision: 0, enum: { ...STATUS_ENUM } });

  it('строка состояния превращается в свой код', () => {
    expect(encodeParam('stopped', param)).toEqual([0]);
    expect(encodeParam('defrost', param)).toEqual([2]);
    expect(decodeParam(encodeParam('running', param), param)).toBe('running');
  });

  it('неописанное состояние не кодируется', () => {
    expect(encodeParam('unknown', param)).toEqual([]);
  });

  it('строка без таблицы enum не кодируется', () => {
    expect(encodeParam('running', makeParam({ dataType: 'uint16' }))).toEqual([]);
  });
});

describe('bits16', () => {
  const param = makeParam({ dataType: 'bits16', precision: 0, bits: [...STATUS_BITS] });

  it('флаги собираются в слово состояния', () => {
    expect(encodeParam({ run: true, defrost: false, fault: true }, param)).toEqual([0x8001]);
    expect(encodeParam({ run: true, defrost: true, fault: false }, param)).toEqual([0x0021]);
  });

  it('invert возвращает флаг в исходный бит', () => {
    const inverted = makeParam({
      dataType: 'bits16',
      precision: 0,
      bits: [{ bit: 2, key: 'healthy', label: 'Исправен', invert: true }],
    });
    expect(encodeParam({ healthy: true }, inverted)).toEqual([0b0000]);
    expect(encodeParam({ healthy: false }, inverted)).toEqual([0b0100]);
  });

  it('отсутствующие и неописанные флаги остаются нулями', () => {
    expect(encodeParam({ fault: true }, param)).toEqual([0x8000]);
    expect(encodeParam({ run: true, stranger: true }, param)).toEqual([0x0001]);
  });

  it('флаги без описания битов не кодируются', () => {
    expect(encodeParam({ run: true }, makeParam({ dataType: 'uint16' }))).toEqual([]);
  });
});

describe('невозможные значения', () => {
  it('выход за диапазон типа не кодируется', () => {
    expect(encodeParam(70000, makeParam({ dataType: 'uint16', precision: 0 }))).toEqual([]);
    expect(encodeParam(-1, makeParam({ dataType: 'uint16', precision: 0 }))).toEqual([]);
    expect(encodeParam(40000, makeParam({ dataType: 'int16', precision: 0 }))).toEqual([]);
    expect(encodeParam(-40000, makeParam({ dataType: 'int16', precision: 0 }))).toEqual([]);
    expect(encodeParam(5e9, makeParam({ dataType: 'uint32', precision: 0 }))).toEqual([]);
  });

  it('null и нечисло не кодируются', () => {
    expect(encodeParam(null, makeParam({ dataType: 'int16' }))).toEqual([]);
    expect(encodeParam(Number.NaN, makeParam({ dataType: 'float32' }))).toEqual([]);
    expect(encodeParam(Number.POSITIVE_INFINITY, makeParam({ dataType: 'float32' }))).toEqual([]);
  });
});
