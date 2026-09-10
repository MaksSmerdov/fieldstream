import type { BitSpec, ParamSpec } from '@fieldstream/contracts';
import { bytesToWords, toWord } from './byte-order.js';
import type { ByteQuad } from './byte-order.js';
import type { DecodedValue } from './decode.js';

/** Четыре байта 32-битного целого в логическом порядке ABCD. */
const int32ToBytes = (value: number): ByteQuad => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

/** Четыре байта числа одинарной точности в логическом порядке ABCD. */
const float32ToBytes = (value: number): ByteQuad => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  return [view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)];
};

/** Числовой код состояния по его строке. Null если строка не описана в enum. */
const codeOfLabel = (label: string, table: Readonly<Record<string, string>>): number | null => {
  for (const [code, name] of Object.entries(table)) {
    if (name !== label) continue;
    const parsed = Number(code);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** Слово состояния из именованных флагов с учётом invert. Неописанные биты остаются нулями. */
const wordOfFlags = (
  flags: Readonly<Record<string, boolean>>,
  bits: readonly BitSpec[],
): number => {
  let word = 0;
  for (const spec of bits) {
    const flag = flags[spec.key];
    if (flag === undefined) continue;
    if ((spec.invert ?? false) ? !flag : flag) word |= 1 << spec.bit;
  }
  return toWord(word);
};

/** Значение в шкале decode: число как есть, строка через enum, флаги в слово состояния. */
const toScaledValue = (value: DecodedValue, param: ParamSpec): number | null => {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return param.enum ? codeOfLabel(value, param.enum) : null;
  return param.bits ? wordOfFlags(value, param.bits) : null;
};

/**
 * Кодирование значения в слова регистров: обратная операция к decodeParam
 * с точностью до scale и precision. Нужна симулятору на запись и round-trip тестам.
 * Пустой массив означает, что значение не кодируется: чужой тип, неизвестное состояние
 * или выход за диапазон типа.
 */
export const encodeParam = (value: DecodedValue, param: ParamSpec): number[] => {
  const scaled = toScaledValue(value, param);
  if (scaled === null || param.scale === 0) return [];

  const raw = (scaled - param.offset) / param.scale;
  if (!Number.isFinite(raw)) return [];
  if (param.dataType === 'float32') return [...bytesToWords(float32ToBytes(raw), param.byteOrder)];

  const whole = Math.round(raw);
  switch (param.dataType) {
    case 'int16':
      return whole < -32768 || whole > 32767 ? [] : [toWord(whole)];
    case 'uint16':
    case 'bits16':
      return whole < 0 || whole > 65535 ? [] : [whole];
    case 'int32':
      return whole < -2147483648 || whole > 2147483647
        ? []
        : [...bytesToWords(int32ToBytes(whole), param.byteOrder)];
    case 'uint32':
      return whole < 0 || whole > 4294967295
        ? []
        : [...bytesToWords(int32ToBytes(whole), param.byteOrder)];
  }
};
