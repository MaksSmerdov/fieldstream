import type { BitSpec, ByteOrder, DataType, ParamSpec } from '@fieldstream/contracts';
import { toWord, wordsToBytes } from './byte-order.js';

/** Результат разбора параметра: число, строка состояния, набор флагов или ничего. */
export type DecodedValue = number | string | Record<string, boolean> | null;

/** Сырое число из слов по типу и порядку байт. Null если слов не хватает под тип. */
const assembleRaw = (
  words: readonly number[],
  dataType: DataType,
  byteOrder: ByteOrder,
): number | null => {
  const first = words[0];
  if (first === undefined) return null;

  const low = toWord(first);
  if (dataType === 'int16') return low >= 0x8000 ? low - 0x10000 : low;
  if (dataType === 'uint16' || dataType === 'bits16') return low;

  const second = words[1];
  if (second === undefined) return null;

  const [a, b, c, d] = wordsToBytes([low, toWord(second)], byteOrder);
  const signed = (a << 24) | (b << 16) | (c << 8) | d;
  if (dataType === 'int32') return signed;
  if (dataType === 'uint32') return signed >>> 0;

  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, signed >>> 0);
  return view.getFloat32(0);
};

/** Округление до знаков после запятой; минус ноль приводится к нулю. */
const roundTo = (value: number, precision: number): number => {
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
};

/** Разбор слова состояния на именованные флаги с учётом invert. */
const decodeBits = (value: number, bits: readonly BitSpec[]): Record<string, boolean> => {
  const word = toWord(Math.trunc(value));
  const flags: Record<string, boolean> = {};
  for (const spec of bits) {
    const on = ((word >>> spec.bit) & 1) === 1;
    flags[spec.key] = (spec.invert ?? false) ? !on : on;
  }
  return flags;
};

/**
 * Разбор параметра из сырых слов.
 * Порядок строгий: слова, сборка по типу и порядку байт, scale и offset, precision, enum или bits.
 * Ошибок не бросает: нехватка слов и неизвестный код enum дают null.
 */
export const decodeParam = (words: readonly number[], param: ParamSpec): DecodedValue => {
  const raw = assembleRaw(words, param.dataType, param.byteOrder);
  if (raw === null || !Number.isFinite(raw)) return null;

  const value = roundTo(raw * param.scale + param.offset, param.precision);
  if (!Number.isFinite(value)) return null;

  if (param.dataType === 'bits16' && param.bits) return decodeBits(value, param.bits);
  if (param.enum) return param.enum[String(value)] ?? null;
  return value;
};
