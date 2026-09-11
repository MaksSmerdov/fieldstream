import { describe, expect, it } from 'vitest';
import { defineDeviceProfile, validateDeviceProfile } from '../../src/profiles/validate.js';
import type { DeviceProfileInput, ProfileIssue } from '../../src/profiles/validate.js';
import { rc2000Profile } from '../../src/profiles/rc-2000.js';
import { pm3PhaseProfile } from '../../src/profiles/pm-3phase.js';

/** Сырое описание профиля: до схемы, чтобы можно было собрать заведомо кривое. */
const rawProfile = (sections: unknown[], extra: Record<string, unknown> = {}): unknown => ({
  profileKey: 'demo',
  version: 1,
  label: 'Демонстрационный профиль',
  ...extra,
  sections,
});

const rawSection = (key: string, params: unknown[]): unknown => ({ key, label: key, params });

const rawParam = (key: string, address: number, extra: Record<string, unknown> = {}): unknown => ({
  key,
  label: key,
  address,
  dataType: 'uint16',
  registerType: 'input',
  ...extra,
});

/** Проблемы профиля или падение теста, если профиль неожиданно прошёл проверку. */
const issuesOf = (input: unknown): readonly ProfileIssue[] => {
  const result = validateDeviceProfile(input);
  if (result.ok) throw new Error('ожидались ошибки валидации, а профиль прошёл проверку');
  return result.issues;
};

const textOf = (issues: readonly ProfileIssue[]): string =>
  issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');

describe('validateDeviceProfile', () => {
  it('реальные профили проходят полную проверку', () => {
    expect(validateDeviceProfile(rc2000Profile).ok).toBe(true);
    expect(validateDeviceProfile(pm3PhaseProfile).ok).toBe(true);
  });

  it('ловит дубль ключа параметра и называет обе секции', () => {
    const issues = issuesOf(
      rawProfile([
        rawSection('temps', [rawParam('supply_temp_c', 0)]),
        rawSection('copy', [rawParam('supply_temp_c', 4)]),
      ]),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('demo / секция copy / параметр supply_temp_c');
    expect(issues[0]?.message).toContain('supply_temp_c');
    expect(issues[0]?.message).toContain('temps');
  });

  it('ловит перекрытие адресов, потому что 32-битный занимает два регистра', () => {
    const issues = issuesOf(
      rawProfile([
        rawSection('energy', [rawParam('energy_kwh', 4, { dataType: 'uint32' })]),
        rawSection('voltage', [rawParam('voltage_l1_v', 5)]),
      ]),
    );
    const text = textOf(issues);

    expect(issues).toHaveLength(1);
    expect(text).toContain('параметр voltage_l1_v');
    expect(text).toContain('energy_kwh');
    expect(text).toContain('input 4..5');
  });

  it('одинаковый адрес в holding и input перекрытием не считается', () => {
    const result = validateDeviceProfile(
      rawProfile([
        rawSection('main', [
          rawParam('setpoint_c', 0, { registerType: 'holding' }),
          rawParam('supply_temp_c', 0, { registerType: 'input' }),
        ]),
      ]),
    );

    expect(result.ok).toBe(true);
  });

  it('ловит перекрытие объявленных блоков и называет оба', () => {
    const issues = issuesOf(
      rawProfile([rawSection('main', [rawParam('a', 0), rawParam('b', 3)])], {
        readPlan: {
          blocks: [
            { id: 'first', registerType: 'input', startAddress: 0, registerCount: 4 },
            { id: 'second', registerType: 'input', startAddress: 3, registerCount: 2 },
          ],
        },
      }),
    );
    const text = textOf(issues);

    expect(text).toContain('блок second');
    expect(text).toContain('"first"');
    expect(text).toContain('перекрывает');
  });

  it('ловит параметр, который не влезает в объявленный блок целиком', () => {
    const issues = issuesOf(
      rawProfile([rawSection('main', [rawParam('energy_kwh', 1, { dataType: 'uint32' })])], {
        readPlan: {
          blocks: [{ id: 'vendor', registerType: 'input', startAddress: 0, registerCount: 2 }],
        },
      }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('demo / секция main / параметр energy_kwh');
    expect(issues[0]?.message).toContain('input 1..2');
  });

  it('ловит объявленный блок длиннее лимита maxBlockRegisters', () => {
    const issues = issuesOf(
      rawProfile([rawSection('main', [rawParam('a', 0)])], {
        maxBlockRegisters: 4,
        readPlan: {
          blocks: [{ id: 'vendor', registerType: 'input', startAddress: 0, registerCount: 100 }],
        },
      }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('demo / readPlan / блок vendor');
    expect(issues[0]?.message).toContain('100');
    expect(issues[0]?.message).toContain('maxBlockRegisters 4');
  });

  it('ловит блок-призрак, который не закрывает ни одного параметра', () => {
    const issues = issuesOf(
      rawProfile([rawSection('main', [rawParam('a', 0)])], {
        readPlan: {
          blocks: [
            { id: 'vendor', registerType: 'input', startAddress: 0, registerCount: 1 },
            { id: 'ghost', registerType: 'input', startAddress: 10, registerCount: 5 },
          ],
        },
      }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('demo / readPlan / блок ghost');
    expect(issues[0]?.message).toContain('input 10..14');
    expect(issues[0]?.message).toContain('ни одного параметра');
  });

  it('ловит параметр, попавший сразу в два объявленных блока', () => {
    const issues = issuesOf(
      rawProfile([rawSection('main', [rawParam('a', 0), rawParam('b', 5)])], {
        readPlan: {
          blocks: [
            { id: 'first', registerType: 'input', startAddress: 0, registerCount: 4 },
            { id: 'second', registerType: 'input', startAddress: 0, registerCount: 6 },
          ],
        },
      }),
    );
    const doubled = issues.filter((issue) => issue.message.includes('дважды за цикл'));
    const text = textOf(doubled);

    expect(doubled).toHaveLength(1);
    expect(doubled[0]?.path).toBe('demo / секция main / параметр a');
    expect(text).toContain('"first"');
    expect(text).toContain('"second"');
  });

  it('ошибка схемы получает путь до секции, параметра и поля', () => {
    const issues = issuesOf(rawProfile([rawSection('temps', [rawParam('supply_temp_c', 70000)])]));

    expect(issues[0]?.path).toBe('demo / секция temps / параметр supply_temp_c / поле address');
  });

  it('сообщение самих контрактов доезжает до пути параметра', () => {
    const issues = issuesOf(
      rawProfile([rawSection('alarms', [rawParam('alarm_bits', 0, { dataType: 'bits16' })])]),
    );

    expect(issues[0]?.path).toBe('demo / секция alarms / параметр alarm_bits / поле bits');
    expect(issues[0]?.message).toContain('bits16');
  });

  it('собирает все проблемы разом, а не первую попавшуюся', () => {
    const issues = issuesOf(
      rawProfile([
        rawSection('main', [rawParam('a', 0), rawParam('a', 0)]),
        rawSection('main', [rawParam('b', 8)]),
      ]),
    );

    expect(issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('defineDeviceProfile', () => {
  const broken: DeviceProfileInput = {
    profileKey: 'broken',
    version: 1,
    label: 'Профиль с дублем',
    sections: [
      {
        key: 'main',
        label: 'Основное',
        params: [
          { key: 'supply_temp_c', label: 'Подача', address: 0, dataType: 'int16' },
          { key: 'supply_temp_c', label: 'Копия', address: 1, dataType: 'int16' },
        ],
      },
    ],
  };

  it('бросает ошибку с именем параметра и путём', () => {
    expect(() => defineDeviceProfile(broken)).toThrow(/supply_temp_c/);
    expect(() => defineDeviceProfile(broken)).toThrow(/broken \/ секция main/);
  });

  it('возвращает профиль с проставленными умолчаниями схемы', () => {
    const profile = defineDeviceProfile({
      profileKey: 'ok',
      version: 1,
      label: 'Минимальный профиль',
      sections: [
        {
          key: 'main',
          label: 'Основное',
          params: [{ key: 'a', label: 'A', address: 0, dataType: 'int16' }],
        },
      ],
    });

    expect(profile.maxBlockRegisters).toBe(125);
    expect(profile.maxGapRegisters).toBe(0);
    expect(profile.sections[0]?.params[0]?.registerType).toBe('holding');
    expect(profile.sections[0]?.params[0]?.byteOrder).toBe('ABCD');
  });
});
