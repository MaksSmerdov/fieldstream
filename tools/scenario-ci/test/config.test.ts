import { describe, expect, it } from 'vitest';
import { parseConfig, parseNames, selectScenarios } from '../src/config.js';

describe('разбор настроек', () => {
  it('без переменных берутся стенд на 8080 и учётка инженера, сценарии все', () => {
    expect(parseConfig([], {})).toEqual({
      ok: true,
      config: {
        baseUrl: 'http://localhost:8080',
        email: 'engineer@fieldstream.local',
        password: 'fieldstream',
        names: null,
        summaryPath: null,
      },
    });
  });

  it('пустые переменные CI читаются как не заданные, косая черта в конце адреса срезается', () => {
    const parsed = parseConfig([], {
      E2E_BASE_URL: 'http://127.0.0.1:8080/',
      E2E_PASSWORD: '',
      SCENARIOS: '',
      GITHUB_STEP_SUMMARY: '/tmp/summary.md',
    });

    expect(parsed).toMatchObject({
      ok: true,
      config: {
        baseUrl: 'http://127.0.0.1:8080',
        password: 'fieldstream',
        names: null,
        summaryPath: '/tmp/summary.md',
      },
    });
  });

  it('неверный адрес и почта возвращаются списком, а не исключением', () => {
    const parsed = parseConfig([], { E2E_BASE_URL: 'localhost', E2E_EMAIL: 'инженер' });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toEqual([
        'E2E_BASE_URL: ожидается адрес вида http://localhost:8080',
        'E2E_EMAIL: ожидается почта учётной записи',
      ]);
    }
  });
});

describe('имена сценариев', () => {
  it('SCENARIOS читается через запятую без пробелов и повторов', () => {
    expect(parseNames([], ' dead-device, crc-garbage,,dead-device ')).toEqual({
      names: ['dead-device', 'crc-garbage'],
      issues: [],
    });
  });

  it('аргументы командной строки важнее SCENARIOS, разделитель pnpm пропускается', () => {
    expect(parseNames(['--', 'offscale-alarm'], 'dead-device')).toEqual({
      names: ['offscale-alarm'],
      issues: [],
    });
  });

  it('имя не в kebab-case это ошибка настроек', () => {
    expect(parseConfig([], { SCENARIOS: 'Dead_Device' })).toEqual({
      ok: false,
      issues: ['«Dead_Device»: имя сценария пишется в kebab-case, например dead-device'],
    });
  });
});

describe('выбор сценариев', () => {
  const available = [{ name: 'crc-garbage' }, { name: 'dead-device' }, { name: 'offscale-alarm' }];

  it('без имён идут все в порядке стенда, с именами в запрошенном порядке', () => {
    expect(selectScenarios(available, null)).toEqual({ ok: true, scenarios: available });
    expect(selectScenarios(available, ['offscale-alarm', 'crc-garbage'])).toEqual({
      ok: true,
      scenarios: [{ name: 'offscale-alarm' }, { name: 'crc-garbage' }],
    });
  });

  it('неизвестное имя называется вместе со списком известных', () => {
    expect(selectScenarios(available, ['dead-device', 'meteor'])).toEqual({
      ok: false,
      issue: 'на стенде нет сценариев meteor, есть: crc-garbage, dead-device, offscale-alarm',
    });
  });

  it('стенд без сценариев это ошибка, а не пустой зелёный прогон', () => {
    expect(selectScenarios([], null)).toEqual({
      ok: false,
      issue: 'на стенде нет ни одного сценария',
    });
  });
});
