import { encodeParam } from '@fieldstream/modbus-codec';
import type { DecodedValue } from '@fieldstream/modbus-codec';
import type { DataType, DeviceProfile, ParamSpec } from '@fieldstream/contracts';
import { listPlanEntries } from './read-plan.js';
import type { PlanBlock } from './read-plan.js';

/** Карта регистров прибора: ровно то, что вернул бы настоящий шлюз. */
export interface SimulationRegisters {
  readonly holding: ReadonlyMap<number, number>;
  readonly input: ReadonlyMap<number, number>;
}

/** Диапазон на случай, если профиль его не описал. */
const FALLBACK_RANGE: Readonly<Record<DataType, readonly [number, number]>> = Object.freeze({
  int16: [-100, 100],
  uint16: [0, 1000],
  bits16: [0, 0],
  int32: [-100000, 100000],
  uint32: [0, 100000],
  float32: [0, 1000],
});

/** Детерминированный хеш строки: заменяет генератор случайных чисел. */
const hash = (text: string): number => {
  let value = 0x811c9dc5;

  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }

  return value;
};

/** Округление точно как в декодере, иначе кодирование перестанет быть обратимым. */
const roundTo = (value: number, precision: number): number => {
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
};

/** Плавная синусоида внутри инженерного диапазона; счётчик вместо неё только растёт. */
const numericValue = (param: ParamSpec, seed: number, salt: number): number => {
  const fallback = FALLBACK_RANGE[param.dataType];
  const min = param.range?.min ?? fallback[0];
  const max = param.range?.max ?? fallback[1];
  const span = max - min;

  if (param.range?.monotonic ?? false) {
    const step = Math.max(span / 50000, 10 ** -param.precision);
    return roundTo(Math.min(max, min + seed * step), param.precision);
  }

  const period = 60 + (salt % 37);
  const phase = ((salt >>> 8) % 1000) / 1000;
  const wave = Math.sin(2 * Math.PI * (phase + seed / period));
  return roundTo(min + span / 2 + span * 0.4 * wave, param.precision);
};

/** Код состояния держится десятками циклов: прибор не дёргается каждый опрос. */
const enumValue = (param: ParamSpec, seed: number, salt: number): DecodedValue => {
  const table = param.enum;
  if (table === undefined) return null;

  const codes = Object.keys(table).sort((left, right) => Number(left) - Number(right));
  const period = 40 + (salt % 23);
  const code = codes[Math.floor((seed + (salt % period)) / period) % codes.length];
  return code === undefined ? null : (table[code] ?? null);
};

/** Каждый бит живёт своим редким циклом, поэтому слово аварий почти всегда спокойное. */
const bitsValue = (param: ParamSpec, seed: number, salt: number): DecodedValue => {
  const specs = param.bits;
  if (specs === undefined) return null;

  const flags: Record<string, boolean> = {};

  for (const spec of specs) {
    const salted = (hash(`${param.key}:${spec.key}`) ^ salt) >>> 0;
    const period = 30 + (salted % 41);
    const bucket = Math.floor((seed + (salted % period)) / period);
    const raised = hash(`${spec.key}:${String(bucket)}`) % 11 === 0;
    flags[spec.key] = (spec.invert ?? false) ? !raised : raised;
  }

  return flags;
};

const simulateParam = (param: ParamSpec, seed: number, salt: number): DecodedValue => {
  if (param.bits !== undefined) return bitsValue(param, seed, salt);
  if (param.enum !== undefined) return enumValue(param, seed, salt);
  return numericValue(param, seed, salt);
};

/**
 * Значения всех параметров профиля на шаге seed.
 * Чистая функция от профиля и seed: соседние seed дают соседние значения,
 * шаг заведомо меньше maxDelta, счётчики монотонны.
 */
export const buildSimulationValues = (
  profile: DeviceProfile,
  seed: number,
): Map<string, DecodedValue> => {
  const values = new Map<string, DecodedValue>();

  for (const entry of listPlanEntries(profile)) {
    const salt = hash(`${profile.profileKey}:${entry.param.key}`);
    values.set(entry.param.key, simulateParam(entry.param, seed, salt));
  }

  return values;
};

/** Те же значения, но уложенные в регистры тем же кодеком, что читает боевой опрос. */
export const buildSimulationRegisters = (
  profile: DeviceProfile,
  seed: number,
): SimulationRegisters => {
  const holding = new Map<number, number>();
  const input = new Map<number, number>();
  const values = buildSimulationValues(profile, seed);

  for (const entry of listPlanEntries(profile)) {
    const words = encodeParam(values.get(entry.param.key) ?? null, entry.param);
    const target = entry.registerType === 'holding' ? holding : input;
    words.forEach((word, offset) => {
      target.set(entry.param.address + offset, word);
    });
  }

  return { holding, input };
};

/** Слова блока так, как их вернул бы прибор: неописанные регистры читаются нулями. */
export const readSimulatedBlock = (registers: SimulationRegisters, block: PlanBlock): number[] => {
  const source = block.registerType === 'holding' ? registers.holding : registers.input;
  const words: number[] = [];

  for (let offset = 0; offset < block.registerCount; offset += 1) {
    words.push(source.get(block.startAddress + offset) ?? 0);
  }

  return words;
};
