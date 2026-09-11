import { WORDS_BY_DATA_TYPE } from '@fieldstream/contracts';
import type { DeviceProfile, ParamSpec, RawBlock } from '@fieldstream/contracts';
import { decodeParam } from '@fieldstream/modbus-codec';
import type { DecodedValue } from '@fieldstream/modbus-codec';
import { listPlanEntries } from './read-plan.js';

/** Параметр из кадра: число для таблицы телеметрии и смысл для логики. */
export interface DecodedMetric {
  readonly key: string;
  readonly value: number | null;
  readonly decoded: DecodedValue;
}

/** Слова параметра из того блока кадра, в котором он лежит целиком. */
const wordsFor = (blocks: readonly RawBlock[], param: ParamSpec): number[] | null => {
  const size = WORDS_BY_DATA_TYPE[param.dataType];

  for (const block of blocks) {
    if (block.registerType !== param.registerType) continue;
    const offset = param.address - block.startAddress;
    if (offset < 0 || offset + size > block.words.length) continue;
    return block.words.slice(offset, offset + size);
  }

  return null;
};

/** Тот же параметр без расшифровки: код перечисления и слово аварий остаются числами. */
const withoutMeaning = (param: ParamSpec): ParamSpec => {
  const plain = { ...param };
  delete plain.enum;
  delete plain.bits;
  return plain;
};

/**
 * Разбор сырого кадра по профилю. В таблицу уходит число: измерение как есть, у перечисления
 * код, у слова аварий само слово. Смысл (метка состояния, флаги) нужен логике режимов и событий.
 * Параметр, которого нет ни в одном блоке кадра, пропускается: придумывать значение нельзя.
 */
export const decodeFrame = (profile: DeviceProfile, blocks: readonly RawBlock[]): DecodedMetric[] =>
  listPlanEntries(profile).flatMap(({ param }) => {
    const words = wordsFor(blocks, param);
    if (words === null) return [];

    const decoded = decodeParam(words, param);
    const numeric =
      param.enum === undefined && param.bits === undefined
        ? decoded
        : decodeParam(words, withoutMeaning(param));

    return [{ key: param.key, value: typeof numeric === 'number' ? numeric : null, decoded }];
  });
