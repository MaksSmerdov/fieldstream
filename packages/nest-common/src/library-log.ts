import type { Clock } from '@fieldstream/domain';
import type { Logger } from './logger.js';
import { createLogThrottle } from './throttle.js';

/** Лог сторонней библиотеки: поля и текст, четыре уровня. */
export interface LibraryLog {
  readonly error: (fields: Record<string, unknown>, message: string) => void;
  readonly warn: (fields: Record<string, unknown>, message: string) => void;
  readonly info: (fields: Record<string, unknown>, message: string) => void;
  readonly debug: (fields: Record<string, unknown>, message: string) => void;
}

/**
 * Лог библиотеки с подавлением дублей ошибок и предупреждений. При недоступном брокере
 * kafkajs повторяет одно и то же каждую секунду, и без этого лог превращается в шум.
 */
export const createThrottledLog = (log: Logger, clock: Clock): LibraryLog => {
  const throttle = createLogThrottle(clock);
  const passed = (
    fields: Record<string, unknown>,
    message: string,
  ): Record<string, unknown> | null => {
    const namespace = typeof fields.namespace === 'string' ? fields.namespace : '';
    const decision = throttle(`${namespace}:${message}`);
    return decision.pass ? { ...fields, suppressed: decision.suppressed } : null;
  };

  return {
    error: (fields, message) => {
      const kept = passed(fields, message);
      if (kept !== null) log.error(kept, message);
    },
    warn: (fields, message) => {
      const kept = passed(fields, message);
      if (kept !== null) log.warn(kept, message);
    },
    info: (fields, message) => {
      log.info(fields, message);
    },
    debug: (fields, message) => {
      log.debug(fields, message);
    },
  };
};
