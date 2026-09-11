import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  dataTypeSchema,
  deviceProfileSchema,
  MUTED_MODES,
  paramSpecSchema,
  WORDS_BY_DATA_TYPE,
} from '../src/device.js';

/** Ошибки схемы как "код путь: текст" или падение теста, если кривое значение прошло разбор. */
const issuesOf = (schema: z.ZodTypeAny, value: unknown): string => {
  const result = schema.safeParse(value);
  if (result.success) throw new Error('ожидалась ошибка схемы, а значение прошло разбор');
  return result.error.issues
    .map((issue) => `${issue.code} ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
};

const param = (extra: Record<string, unknown> = {}): unknown => ({
  key: 'supply_temp_c',
  label: 'Температура подачи',
  address: 10,
  dataType: 'int16',
  ...extra,
});

const profile = (extra: Record<string, unknown> = {}): unknown => ({
  profileKey: 'rc-2000',
  version: 1,
  label: 'Контроллер камеры',
  sections: [{ key: 'temps', label: 'Температуры', params: [param()] }],
  ...extra,
});

describe('WORDS_BY_DATA_TYPE', () => {
  it('покрывает все типы данных и ровно их', () => {
    expect(Object.keys(WORDS_BY_DATA_TYPE).sort()).toEqual([...dataTypeSchema.options].sort());
  });

  it('тридцатидвухбитная величина занимает два регистра, остальные один', () => {
    const wrong = dataTypeSchema.options.filter(
      (dataType) => WORDS_BY_DATA_TYPE[dataType] !== (dataType.endsWith('32') ? 2 : 1),
    );

    expect(wrong).toEqual([]);
  });
});

describe('paramSpecSchema', () => {
  it('минимальный параметр получает дефолты чтения и обработки', () => {
    expect(paramSpecSchema.parse(param())).toEqual({
      key: 'supply_temp_c',
      label: 'Температура подачи',
      address: 10,
      dataType: 'int16',
      registerType: 'holding',
      byteOrder: 'ABCD',
      scale: 1,
      offset: 0,
      precision: 2,
      acceptAfter: 3,
    });
  });

  it('слово состояния разбирается на биты', () => {
    const parsed = paramSpecSchema.parse(
      param({
        key: 'status',
        dataType: 'bits16',
        bits: [{ bit: 0, key: 'alarm', label: 'Авария' }],
      }),
    );

    expect(parsed.bits).toEqual([{ bit: 0, key: 'alarm', label: 'Авария' }]);
  });

  it('биты без типа bits16 отвергаются', () => {
    expect(
      issuesOf(paramSpecSchema, param({ bits: [{ bit: 0, key: 'a', label: 'A' }] })),
    ).toContain('bits допустимы только при dataType "bits16"');
  });

  it('тип bits16 без описания битов отвергается', () => {
    expect(issuesOf(paramSpecSchema, param({ dataType: 'bits16' }))).toContain(
      'при dataType "bits16" нужно описать bits',
    );
  });

  it('вырожденный инженерный диапазон отвергается', () => {
    expect(issuesOf(paramSpecSchema, param({ range: { min: 10, max: 10 } }))).toContain(
      'range.min должен быть меньше range.max',
    );
  });

  it('расшифровка кодов несовместима с плавающей точкой', () => {
    expect(
      issuesOf(paramSpecSchema, param({ dataType: 'float32', enum: { '0': 'выкл' } })),
    ).toContain('enum несовместим с float32');
  });

  it('неизвестный ключ параметра отвергается', () => {
    expect(issuesOf(paramSpecSchema, param({ scaleFactor: 10 }))).toContain('unrecognized_keys');
  });

  it('адрес вне адресного пространства Modbus отвергается', () => {
    expect(issuesOf(paramSpecSchema, param({ address: 65_536 }))).toContain('too_big address');
    expect(issuesOf(paramSpecSchema, param({ address: -1 }))).toContain('too_small address');
  });
});

describe('deviceProfileSchema', () => {
  it('минимальный профиль получает дефолты сборки блоков', () => {
    const parsed = deviceProfileSchema.parse(profile());

    expect(parsed.maxBlockRegisters).toBe(125);
    expect(parsed.maxGapRegisters).toBe(0);
    expect(parsed.readPlan).toBeUndefined();
  });

  it('профиль без секций и секция без параметров отвергаются', () => {
    expect(issuesOf(deviceProfileSchema, profile({ sections: [] }))).toContain(
      'too_small sections',
    );
    expect(
      issuesOf(deviceProfileSchema, profile({ sections: [{ key: 'a', label: 'A', params: [] }] })),
    ).toContain('too_small sections.0.params');
  });

  it('блок чтения длиннее предела Modbus отвергается', () => {
    expect(
      issuesOf(
        deviceProfileSchema,
        profile({
          readPlan: {
            blocks: [{ id: 'b1', registerType: 'input', startAddress: 0, registerCount: 126 }],
          },
        }),
      ),
    ).toContain('too_big readPlan.blocks.0.registerCount');
  });
});

describe('MUTED_MODES', () => {
  it('алармы заглушены только в обслуживании и при выключенном объекте', () => {
    expect([...MUTED_MODES].sort()).toEqual(['off', 'service']);
  });
});
