import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

describe('loadEnv', () => {
  it('пустое окружение даёт рабочие умолчания', () => {
    expect(loadEnv({})).toMatchObject({
      SIM_SEED: 'fieldstream',
      SIM_HTTP_PORT: 8090,
      SIM_SPEED: 1,
      LOG_LEVEL: 'info',
    });
  });

  it('строки из файла окружения приводятся к числам', () => {
    expect(loadEnv({ SIM_HTTP_PORT: '9000', SIM_SPEED: '60' })).toMatchObject({
      SIM_HTTP_PORT: 9000,
      SIM_SPEED: 60,
    });
  });

  it('разброс времени ответа по умолчанию 40 мс и принимается в пределах 0..1000', () => {
    const jitterOf = (value: string): number =>
      loadEnv({ SIM_TURNAROUND_JITTER_MS: value }).SIM_TURNAROUND_JITTER_MS;

    expect(loadEnv({}).SIM_TURNAROUND_JITTER_MS).toBe(40);
    expect(jitterOf('0')).toBe(0);
    expect(jitterOf('1000')).toBe(1000);
    for (const value of ['-1', '1001', '2.5', 'abc']) {
      expect(() => jitterOf(value)).toThrow(/SIM_TURNAROUND_JITTER_MS/);
    }
  });

  it('неверные значения роняют старт со списком всех переменных', () => {
    expect(() => loadEnv({ SIM_HTTP_PORT: 'abc', SIM_SPEED: '100' })).toThrow(
      /SIM_HTTP_PORT[\s\S]*SIM_SPEED/,
    );
  });
});
