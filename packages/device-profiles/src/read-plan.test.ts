import { describe, expect, it } from 'vitest';
import { decodeParam } from '@fieldstream/modbus-codec';
import type { DecodedValue } from '@fieldstream/modbus-codec';
import { deviceProfileSchema } from '@fieldstream/contracts';
import type { DataType, DeviceProfile, ReadBlock, RegisterType } from '@fieldstream/contracts';
import { buildDeviceReadPlan, listPlanEntries, paramWordsInBlock } from './read-plan.js';
import type { ReadPlan } from './read-plan.js';
import {
  buildSimulationRegisters,
  buildSimulationValues,
  readSimulatedBlock,
} from './simulation.js';
import { rc2000Profile } from './profiles/rc-2000.js';
import { pm3PhaseProfile } from './profiles/pm-3phase.js';

interface TestParam {
  key: string;
  address: number;
  dataType?: DataType;
  registerType?: RegisterType;
}

interface TestOptions {
  maxGapRegisters?: number;
  maxBlockRegisters?: number;
  blocks?: readonly ReadBlock[];
}

/** Профиль из голых параметров: только адрес и тип, всё остальное по умолчанию схемы. */
const profileOf = (params: readonly TestParam[], options: TestOptions = {}): DeviceProfile =>
  deviceProfileSchema.parse({
    profileKey: 'test',
    version: 1,
    label: 'Тестовый профиль',
    maxGapRegisters: options.maxGapRegisters ?? 0,
    maxBlockRegisters: options.maxBlockRegisters ?? 125,
    ...(options.blocks === undefined ? {} : { readPlan: { blocks: options.blocks } }),
    sections: [
      {
        key: 'main',
        label: 'Основное',
        params: params.map((param) => ({
          key: param.key,
          label: param.key,
          address: param.address,
          dataType: param.dataType ?? 'uint16',
          registerType: param.registerType ?? 'holding',
        })),
      },
    ],
  });

/** Блоки плана как [тип, адрес, число регистров]: так таблицу ожиданий видно целиком. */
const shapeOf = (plan: ReadPlan): [RegisterType, number, number][] =>
  plan.blocks.map((block) => [block.registerType, block.startAddress, block.registerCount]);

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

const wideRun = (count: number): TestParam[] =>
  Array.from({ length: count }, (_, index) => ({ key: `p${index}`, address: index }));

const MERGE_CASES: readonly {
  name: string;
  params: readonly TestParam[];
  options?: TestOptions;
  expected: [RegisterType, number, number][];
}[] = [
  {
    name: 'соседние адреса склеиваются в один запрос',
    params: [
      { key: 'a', address: 0 },
      { key: 'b', address: 1 },
      { key: 'c', address: 2 },
    ],
    expected: [['holding', 0, 3]],
  },
  {
    name: 'разрыв в один регистр рвёт блок: лишнее не читаем',
    params: [
      { key: 'a', address: 0 },
      { key: 'b', address: 1 },
      { key: 'c', address: 3 },
    ],
    expected: [
      ['holding', 0, 2],
      ['holding', 3, 1],
    ],
  },
  {
    name: 'maxGapRegisters разрешает перешагнуть дыру',
    params: [
      { key: 'a', address: 0 },
      { key: 'b', address: 1 },
      { key: 'c', address: 3 },
    ],
    options: { maxGapRegisters: 1 },
    expected: [['holding', 0, 4]],
  },
  {
    name: 'разрыв больше maxGapRegisters всё равно рвёт блок',
    params: [
      { key: 'a', address: 0 },
      { key: 'b', address: 3 },
    ],
    options: { maxGapRegisters: 1 },
    expected: [
      ['holding', 0, 1],
      ['holding', 3, 1],
    ],
  },
  {
    name: '32-битный параметр склеивается с соседом вплотную',
    params: [
      { key: 'a', address: 0, dataType: 'uint32' },
      { key: 'b', address: 2 },
    ],
    expected: [['holding', 0, 3]],
  },
  {
    name: 'лимит 125 регистров рвёт блок ровно по границе протокола',
    params: wideRun(130),
    expected: [
      ['holding', 0, 125],
      ['holding', 125, 5],
    ],
  },
  {
    name: 'урезанный лимит не рвёт 32-битный параметр пополам',
    params: [
      { key: 'a', address: 0 },
      { key: 'b', address: 1, dataType: 'uint32' },
      { key: 'c', address: 3 },
    ],
    options: { maxBlockRegisters: 2 },
    expected: [
      ['holding', 0, 1],
      ['holding', 1, 2],
      ['holding', 3, 1],
    ],
  },
  {
    name: 'регистры разных типов не склеиваются: это разные функции протокола',
    params: [
      { key: 'a', address: 0, registerType: 'holding' },
      { key: 'b', address: 1, registerType: 'input' },
    ],
    expected: [
      ['holding', 0, 1],
      ['input', 1, 1],
    ],
  },
  {
    name: 'одинаковые адреса в holding и input живут независимо',
    params: [
      { key: 'a', address: 0, registerType: 'holding' },
      { key: 'b', address: 0, registerType: 'input' },
      { key: 'c', address: 1, registerType: 'input' },
    ],
    expected: [
      ['holding', 0, 1],
      ['input', 0, 2],
    ],
  },
];

describe('buildDeviceReadPlan', () => {
  for (const testCase of MERGE_CASES) {
    it(testCase.name, () => {
      const profile = profileOf(testCase.params, testCase.options ?? {});

      expect(shapeOf(buildDeviceReadPlan(profile))).toEqual(testCase.expected);
    });
  }

  it('склеенный блок никогда не читает регистр, который никому не нужен', () => {
    const profile = profileOf([
      { key: 'a', address: 0 },
      { key: 'b', address: 1 },
      { key: 'c', address: 5 },
    ]);

    expect(buildDeviceReadPlan(profile).wastedRegisters).toBe(0);
  });

  it('наивный режим даёт ровно по запросу на параметр', () => {
    const profile = profileOf([
      { key: 'a', address: 0 },
      { key: 'b', address: 1, dataType: 'uint32' },
      { key: 'c', address: 3 },
    ]);
    const plan = buildDeviceReadPlan(profile, { mode: 'naive' });

    expect(plan.requestCount).toBe(3);
    expect(plan.blocks.map((block) => block.paramKeys)).toEqual([['a'], ['b'], ['c']]);
    expect(shapeOf(plan)).toEqual([
      ['holding', 0, 1],
      ['holding', 1, 2],
      ['holding', 3, 1],
    ]);
  });

  it('объявленные блоки имеют приоритет над автосборкой', () => {
    const profile = profileOf(
      [
        { key: 'a', address: 0, registerType: 'input' },
        { key: 'b', address: 4, registerType: 'input' },
      ],
      { blocks: [{ id: 'vendor', registerType: 'input', startAddress: 0, registerCount: 5 }] },
    );
    const plan = buildDeviceReadPlan(profile);

    expect(shapeOf(plan)).toEqual([['input', 0, 5]]);
    expect(plan.blocks[0]?.id).toBe('vendor');
    expect(plan.blocks[0]?.source).toBe('declared');
    expect(plan.wastedRegisters).toBe(3);
  });

  it('параметр вне объявленных блоков не теряется, а получает свой блок', () => {
    const profile = profileOf(
      [
        { key: 'a', address: 0, registerType: 'input' },
        { key: 'forgotten', address: 40, registerType: 'input' },
      ],
      { blocks: [{ id: 'vendor', registerType: 'input', startAddress: 0, registerCount: 1 }] },
    );
    const plan = buildDeviceReadPlan(profile);

    expect(shapeOf(plan)).toEqual([
      ['input', 0, 1],
      ['input', 40, 1],
    ]);
    expect(plan.blocks[1]?.source).toBe('merged');
  });

  it('ignoreDeclaredBlocks возвращает автосборку', () => {
    const profile = profileOf(
      [
        { key: 'a', address: 0, registerType: 'input' },
        { key: 'b', address: 4, registerType: 'input' },
      ],
      { blocks: [{ id: 'vendor', registerType: 'input', startAddress: 0, registerCount: 5 }] },
    );

    expect(shapeOf(buildDeviceReadPlan(profile, { ignoreDeclaredBlocks: true }))).toEqual([
      ['input', 0, 1],
      ['input', 4, 1],
    ]);
  });

  it('32-битный параметр при лимите блока в один регистр это ошибка описания', () => {
    const profile = profileOf([{ key: 'energy_kwh', address: 0, dataType: 'uint32' }], {
      maxBlockRegisters: 1,
    });

    expect(() => buildDeviceReadPlan(profile)).toThrow(/energy_kwh/);
    expect(() => buildDeviceReadPlan(profile)).toThrow(/нельзя разорвать/);
  });

  it('наивный режим ругается на тот же лимит блока, что и склейка', () => {
    const profile = profileOf([{ key: 'energy_kwh', address: 0, dataType: 'uint32' }], {
      maxBlockRegisters: 1,
    });

    expect(() => buildDeviceReadPlan(profile, { mode: 'naive' })).toThrow(/energy_kwh/);
    expect(() => buildDeviceReadPlan(profile, { mode: 'naive' })).toThrow(/нельзя разорвать/);
  });

  it('объявленный блок длиннее лимита это ошибка описания, а не молчаливый запрос', () => {
    const profile = profileOf([{ key: 'a', address: 0, registerType: 'input' }], {
      maxBlockRegisters: 4,
      blocks: [{ id: 'vendor', registerType: 'input', startAddress: 0, registerCount: 100 }],
    });

    expect(() => buildDeviceReadPlan(profile)).toThrow(/vendor/);
    expect(() => buildDeviceReadPlan(profile)).toThrow(/за один запрос/);
  });

  it('параметр из двух перекрывающихся объявленных блоков читается один раз', () => {
    const profile = profileOf(
      [
        { key: 'a', address: 0, registerType: 'input' },
        { key: 'b', address: 5, registerType: 'input' },
      ],
      {
        blocks: [
          { id: 'first', registerType: 'input', startAddress: 0, registerCount: 4 },
          { id: 'second', registerType: 'input', startAddress: 0, registerCount: 6 },
        ],
      },
    );
    const plan = buildDeviceReadPlan(profile);

    expect(plan.blocks.flatMap((block) => block.paramKeys)).toEqual(['a', 'b']);
    expect(plan.blocks.map((block) => [block.id, block.paramKeys])).toEqual([
      ['first', ['a']],
      ['second', ['b']],
    ]);
  });

  it('объявленный блок без единого параметра запросом не уходит', () => {
    const profile = profileOf([{ key: 'a', address: 0, registerType: 'input' }], {
      blocks: [
        { id: 'vendor', registerType: 'input', startAddress: 0, registerCount: 1 },
        { id: 'ghost', registerType: 'input', startAddress: 10, registerCount: 5 },
      ],
    });
    const plan = buildDeviceReadPlan(profile);

    expect(shapeOf(plan)).toEqual([['input', 0, 1]]);
    expect(plan.requestCount).toBe(1);
    expect(plan.registerCount).toBe(1);
    expect(plan.wastedRegisters).toBe(0);
  });
});

describe('план на реальных профилях', () => {
  it('главный инвариант: склеенный план читает ровно то же, что наивный', () => {
    for (const profile of [rc2000Profile, pm3PhaseProfile]) {
      const merged = buildDeviceReadPlan(profile);
      const naive = buildDeviceReadPlan(profile, { mode: 'naive' });

      for (let seed = 0; seed < 50; seed += 1) {
        const byMerged = readByPlan(profile, merged, seed);

        expect(byMerged).toEqual(readByPlan(profile, naive, seed));
        expect(byMerged).toEqual(Object.fromEntries(buildSimulationValues(profile, seed)));
      }
    }
  });

  it('склейка заметно сокращает число запросов', () => {
    for (const profile of [rc2000Profile, pm3PhaseProfile]) {
      const merged = buildDeviceReadPlan(profile);
      const naive = buildDeviceReadPlan(profile, { mode: 'naive' });

      expect(naive.requestCount).toBe(listPlanEntries(profile).length);
      expect(merged.requestCount * 2).toBeLessThanOrEqual(naive.requestCount);
    }

    expect(buildDeviceReadPlan(rc2000Profile).requestCount).toBe(4);
    expect(buildDeviceReadPlan(pm3PhaseProfile).requestCount).toBe(3);
  });

  it('автосборка RC-2000 не читает ни одного лишнего регистра', () => {
    const plan = buildDeviceReadPlan(rc2000Profile);

    expect(plan.wastedRegisters).toBe(0);
    expect(shapeOf(plan)).toEqual([
      ['holding', 0, 1],
      ['input', 0, 4],
      ['input', 16, 3],
      ['input', 32, 1],
    ]);
  });

  it('объявленный блок PM-3Phase платит одним лишним регистром за экономию запроса', () => {
    const plan = buildDeviceReadPlan(pm3PhaseProfile);
    const auto = buildDeviceReadPlan(pm3PhaseProfile, { ignoreDeclaredBlocks: true });

    expect(plan.wastedRegisters).toBe(1);
    expect(plan.requestCount).toBeLessThan(auto.requestCount);
  });
});

describe('paramWordsInBlock', () => {
  it('отдаёт пусто, если параметр лежит в блоке не целиком', () => {
    const profile = profileOf([{ key: 'wide', address: 4, dataType: 'uint32' }]);
    const param = listPlanEntries(profile)[0]?.param;
    const block = buildDeviceReadPlan(profile).blocks[0];

    expect(param).toBeDefined();
    expect(block).toBeDefined();
    if (param === undefined || block === undefined) return;

    expect(paramWordsInBlock(block, [11, 22], param)).toEqual([11, 22]);
    expect(paramWordsInBlock({ ...block, registerCount: 1 }, [11], param)).toEqual([]);
    expect(paramWordsInBlock({ ...block, startAddress: 5 }, [11, 22], param)).toEqual([]);
  });
});
