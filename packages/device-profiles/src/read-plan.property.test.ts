import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Arbitrary } from 'fast-check';
import { decodeParam } from '@fieldstream/modbus-codec';
import type { DecodedValue } from '@fieldstream/modbus-codec';
import { deviceProfileSchema } from '@fieldstream/contracts';
import type { DeviceProfile, ReadBlock, RegisterType } from '@fieldstream/contracts';
import {
  buildDeviceReadPlan,
  entryFitsBlock,
  listPlanEntries,
  paramWordsInBlock,
  MODBUS_MAX_BLOCK_REGISTERS,
} from './read-plan.js';
import type { ReadPlan } from './read-plan.js';
import { buildSimulationRegisters, readSimulatedBlock } from './simulation.js';

const registerTypeArb: Arbitrary<RegisterType> = fc
  .boolean()
  .map((isInput) => (isInput ? 'input' : 'holding'));

const wordsArb: Arbitrary<1 | 2> = fc.boolean().map((wide) => (wide ? 2 : 1));

/** Сырой параметр профиля: до разбора схемой, ровно то, что кладут в секцию. */
interface RawParam {
  readonly key: string;
  readonly label: string;
  readonly address: number;
  readonly registerType: RegisterType;
  readonly dataType: 'uint16' | 'uint32';
}

interface GeneratedParam {
  readonly step: number;
  readonly words: 1 | 2;
  readonly registerType: RegisterType;
}

const otherType = (type: RegisterType): RegisterType => (type === 'holding' ? 'input' : 'holding');

/** Адреса от общего курсора: отрицательный шаг даёт совпадающие и перекрывающиеся адреса. */
const rawParamsOf = (generated: readonly GeneratedParam[]): RawParam[] => {
  const next: Record<RegisterType, number> = { holding: 0, input: 0 };

  return generated.map((item, index) => {
    const address = Math.max(0, next[item.registerType] + item.step);
    next[item.registerType] = Math.max(next[item.registerType], address + item.words);

    return {
      key: `p${index}`,
      label: `p${index}`,
      address,
      registerType: item.registerType,
      dataType: item.words === 1 ? 'uint16' : 'uint32',
    };
  });
};

/** Объявленные блоки вокруг реальных адресов: часть перекрывается, часть остаётся пустой. */
const rawBlocksArb = (params: readonly RawParam[], maxBlock: number): Arbitrary<ReadBlock[]> =>
  fc
    .array(
      fc.record({
        anchor: fc.nat({ max: Math.max(params.length - 1, 0) }),
        shift: fc.integer({ min: -3, max: 6 }),
        count: fc.integer({ min: 1, max: Math.min(maxBlock, 12) }),
        flip: fc.integer({ min: 0, max: 4 }),
      }),
      { minLength: 1, maxLength: 5 },
    )
    .map((items) =>
      items.map((item, index) => {
        const anchored = params[item.anchor];
        const anchorType: RegisterType = anchored?.registerType ?? 'holding';

        return {
          id: `b${index}`,
          registerType: item.flip === 0 ? otherType(anchorType) : anchorType,
          startAddress: Math.max(0, (anchored?.address ?? 0) + item.shift),
          registerCount: item.count,
        };
      }),
    );

/** Профиль по заказу: минимальный шаг адреса, разрешённый разрыв и наличие объявленных блоков. */
const profileArb = (
  minStep: number,
  maxGapArb: Arbitrary<number>,
  withBlocks: boolean,
): Arbitrary<DeviceProfile> =>
  fc
    .tuple(
      fc.array(
        fc.record({
          step: fc.integer({ min: minStep, max: 8 }),
          words: wordsArb,
          registerType: registerTypeArb,
        }),
        { minLength: 1, maxLength: 40 },
      ),
      maxGapArb,
      fc.integer({ min: 2, max: MODBUS_MAX_BLOCK_REGISTERS }),
    )
    .chain(([generated, maxGapRegisters, maxBlockRegisters]) => {
      const params = rawParamsOf(generated);
      const blocksArb = withBlocks
        ? rawBlocksArb(params, maxBlockRegisters)
        : fc.constant<ReadBlock[]>([]);

      return blocksArb.map((blocks) =>
        deviceProfileSchema.parse({
          profileKey: 'generated',
          version: 1,
          label: 'Сгенерированный профиль',
          maxGapRegisters,
          maxBlockRegisters,
          ...(blocks.length === 0 ? {} : { readPlan: { blocks } }),
          sections: [{ key: 'main', label: 'Основное', params }],
        }),
      );
    });

const gapArb = fc.integer({ min: 0, max: 16 });

/** Ровные профили: адреса не перекрываются, объявленных блоков нет. */
const tidyProfileArb = profileArb(0, gapArb, false);

/** Кривые профили: адреса совпадают и перекрываются, блоки объявлены руками. */
const messyProfileArb = profileArb(-3, gapArb, true);

/** Профили с запретом на дыры: ровно тот режим, ради которого склейка и написана. */
const tightProfileArb = profileArb(-3, fc.constant(0), false);

/** Читает все параметры профиля по готовому плану так же, как это сделает боевой опрос. */
const readByPlan = (
  profile: DeviceProfile,
  plan: ReadPlan,
  seed: number,
): Record<string, DecodedValue> => {
  const registers = buildSimulationRegisters(profile, seed);
  const params = new Map(listPlanEntries(profile).map((entry) => [entry.param.key, entry.param]));
  const values = new Map<string, DecodedValue>();

  for (const block of plan.blocks) {
    const words = readSimulatedBlock(registers, block);

    for (const key of block.paramKeys) {
      const param = params.get(key);
      if (param === undefined) continue;
      values.set(key, decodeParam(paramWordsInBlock(block, words, param), param));
    }
  }

  return Object.fromEntries(values);
};

describe('свойства плана чтения', () => {
  it('на любом валидном наборе параметров план остаётся корректным', () => {
    fc.assert(
      fc.property(tidyProfileArb, (profile) => {
        const plan = buildDeviceReadPlan(profile);
        const entries = listPlanEntries(profile);

        for (const entry of entries) {
          expect(plan.blocks.filter((block) => entryFitsBlock(entry, block))).toHaveLength(1);
        }

        expect(plan.blocks.flatMap((block) => block.paramKeys).sort()).toEqual(
          entries.map((entry) => entry.param.key).sort(),
        );

        for (const block of plan.blocks) {
          expect(block.registerCount).toBeGreaterThan(0);
          expect(block.registerCount).toBeLessThanOrEqual(MODBUS_MAX_BLOCK_REGISTERS);
          expect(block.registerCount).toBeLessThanOrEqual(profile.maxBlockRegisters);
        }

        for (const registerType of ['holding', 'input'] as const) {
          const sameType = plan.blocks.filter((block) => block.registerType === registerType);

          for (let index = 1; index < sameType.length; index += 1) {
            const previous = sameType[index - 1];
            const current = sameType[index];
            if (previous === undefined || current === undefined) continue;

            expect(current.startAddress).toBeGreaterThan(
              previous.startAddress + previous.registerCount - 1,
            );
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('объявленные блоки: лимит соблюдён, призраков нет, параметр читается один раз', () => {
    fc.assert(
      fc.property(messyProfileArb, (profile) => {
        const plan = buildDeviceReadPlan(profile);
        const entries = listPlanEntries(profile);
        const covered = plan.blocks.flatMap((block) => block.paramKeys);

        expect([...covered].sort()).toEqual(entries.map((entry) => entry.param.key).sort());
        expect(new Set(covered).size).toBe(covered.length);

        for (const entry of entries) {
          expect(plan.blocks.some((block) => block.paramKeys.includes(entry.param.key))).toBe(true);
          expect(plan.blocks.some((block) => entryFitsBlock(entry, block))).toBe(true);
        }

        for (const block of plan.blocks) {
          expect(block.paramKeys.length).toBeGreaterThan(0);
          expect(block.registerCount).toBeLessThanOrEqual(profile.maxBlockRegisters);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('при maxGapRegisters = 0 план не читает ни одного лишнего регистра', () => {
    fc.assert(
      fc.property(tightProfileArb, (profile) => {
        expect(buildDeviceReadPlan(profile).wastedRegisters).toBe(0);
      }),
      { numRuns: 300 },
    );
  });

  it('наивный режим даёт ровно по запросу на параметр и не нарушает лимит блока', () => {
    fc.assert(
      fc.property(messyProfileArb, (profile) => {
        const plan = buildDeviceReadPlan(profile, { mode: 'naive' });
        const entries = listPlanEntries(profile);

        expect(plan.mode).toBe('naive');
        expect(plan.requestCount).toBe(entries.length);
        expect(plan.blocks.map((block) => block.paramKeys)).toEqual(
          entries.map((entry) => [entry.param.key]),
        );

        for (const block of plan.blocks) {
          expect(block.registerCount).toBeLessThanOrEqual(profile.maxBlockRegisters);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('главный инвариант: склеенный план даёт те же значения, что наивный', () => {
    fc.assert(
      fc.property(messyProfileArb, fc.integer({ min: 0, max: 500 }), (profile, seed) => {
        const merged = buildDeviceReadPlan(profile);
        const naive = buildDeviceReadPlan(profile, { mode: 'naive' });
        const auto = buildDeviceReadPlan(profile, { ignoreDeclaredBlocks: true });

        expect(readByPlan(profile, merged, seed)).toEqual(readByPlan(profile, naive, seed));
        expect(readByPlan(profile, auto, seed)).toEqual(readByPlan(profile, naive, seed));
        expect(merged.requestCount).toBeLessThanOrEqual(naive.requestCount);
      }),
      { numRuns: 200 },
    );
  });
});
