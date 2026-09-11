import type { ErrorKind } from '@fieldstream/contracts';
import { HardTimeoutError } from './timeouts.js';

/** Поле объекта ошибки. */
const fieldOf = (error: object, name: string): unknown => Reflect.get(error, name);

/**
 * Причина отказа по ошибке клиента. От неё зависит реакция: исключение и искажённый кадр
 * говорят о приборе, таймаут может быть и прибором и линией, обрыв требует переподключения,
 * а зависание требует пересоздать клиент. Причина читается из полей, а не по instanceof:
 * ошибка таймаута modbus-serial не наследует Error.
 */
export const classifyError = (error: unknown): ErrorKind => {
  if (error instanceof HardTimeoutError) return 'stalled';
  if (typeof error !== 'object' || error === null) return 'disconnected';

  const message = fieldOf(error, 'message');
  const text = typeof message === 'string' ? message : '';

  if (typeof fieldOf(error, 'modbusCode') === 'number') return 'exception';
  if (fieldOf(error, 'errno') === 'ETIMEDOUT' || /timed out/i.test(text)) return 'timeout';
  if (/data length error|unexpected data|crc error/i.test(text)) return 'crc';

  return 'disconnected';
};

/** После каких отказов соединение с портом шлюза больше не годится. */
export const needsReconnect = (kind: ErrorKind): boolean =>
  kind === 'disconnected' || kind === 'stalled';
