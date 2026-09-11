import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

describe('loadEnv', () => {
  it('пустое окружение даёт умолчания для разработки на хосте', () => {
    expect(loadEnv({})).toMatchObject({
      KAFKA_BROKERS: ['localhost:29092'],
      COLLECTOR_HTTP_PORT: 8091,
      COLLECTOR_BUFFER_CAPACITY: 2_000,
    });
  });

  it('списки режутся по запятой, пустые строки считаются незаданными', () => {
    const env = loadEnv({
      KAFKA_BROKERS: 'kafka:9092, kafka-2:9092',
      COLLECTOR_LINES: 'L1,L3',
      MODBUS_HOST_OVERRIDE: '',
    });

    expect(env.KAFKA_BROKERS).toEqual(['kafka:9092', 'kafka-2:9092']);
    expect(env.COLLECTOR_LINES).toEqual(['L1', 'L3']);
    expect(env.MODBUS_HOST_OVERRIDE).toBeUndefined();
  });

  it('неверные значения роняют старт со списком переменных', () => {
    expect(() => loadEnv({ COLLECTOR_HTTP_PORT: '0', COLLECTOR_BUFFER_CAPACITY: '5' })).toThrow(
      /COLLECTOR_HTTP_PORT[\s\S]*COLLECTOR_BUFFER_CAPACITY/,
    );
  });
});
