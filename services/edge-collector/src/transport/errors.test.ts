import { describe, expect, it } from 'vitest';
import { classifyError, needsReconnect } from './errors.js';
import { HardTimeoutError } from './timeouts.js';

/** Ошибка с полями, которые добавляет клиентская библиотека. */
const libraryError = (message: string, fields: Record<string, unknown>): Error =>
  Object.assign(new Error(message), fields);

describe('классификация ошибок', () => {
  it('ошибки клиента modbus-serial раскладываются по причинам', () => {
    expect(
      classifyError(libraryError('Modbus exception 11: Gateway target device', { modbusCode: 11 })),
    ).toBe('exception');
    expect(classifyError(libraryError('Timed out', { errno: 'ETIMEDOUT' }))).toBe('timeout');
    expect(classifyError(new Error('Data length error, expected 13 got 11'))).toBe('crc');
    expect(classifyError(new Error('Unexpected data error, expected address 1 got 2'))).toBe('crc');
    expect(classifyError(libraryError('Port Not Open', { errno: 'ECONNREFUSED' }))).toBe(
      'disconnected',
    );
    expect(
      classifyError(libraryError('connect ECONNREFUSED 127.0.0.1:5020', { code: 'ECONNREFUSED' })),
    ).toBe('disconnected');
  });

  it('жёсткий таймаут означает зависание, а не обычный таймаут', () => {
    expect(classifyError(new HardTimeoutError(1_450))).toBe('stalled');
  });

  it('не-ошибка считается обрывом: о состоянии соединения ничего не известно', () => {
    expect(classifyError('странное')).toBe('disconnected');
  });

  it('переподключение нужно только после обрыва и зависания', () => {
    expect(needsReconnect('disconnected')).toBe(true);
    expect(needsReconnect('stalled')).toBe(true);
    expect(needsReconnect('timeout')).toBe(false);
    expect(needsReconnect('crc')).toBe(false);
    expect(needsReconnect('exception')).toBe(false);
  });
});
