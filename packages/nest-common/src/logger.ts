import { pino } from 'pino';
import type { Logger } from 'pino';

export type { Logger } from 'pino';

/** Логгер сервиса: одна строка JSON на событие, имя сервиса в каждой записи. */
export const createLogger = (service: string, level: string): Logger =>
  pino({ level, base: { service } });

/** Текст сообщения Nest: строка как есть, ошибка своим текстом, остальное в JSON. */
const textOf = (message: unknown): string => {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  return message === undefined ? '' : JSON.stringify(message);
};

/** Контекст Nest передаёт последним строковым параметром. */
const contextOf = (params: readonly unknown[]): string | undefined => {
  const last = params[params.length - 1];
  return typeof last === 'string' ? last : undefined;
};

/**
 * Логи самого Nest идут через тот же pino, что и логи сервиса.
 * Класс совпадает с LoggerService по форме, поэтому пакету не нужна зависимость от Nest.
 */
export class NestPinoLogger {
  private readonly target: Logger;

  public constructor(target: Logger) {
    this.target = target;
  }

  public log(message: unknown, ...params: unknown[]): void {
    this.target.info({ context: contextOf(params) }, textOf(message));
  }

  public error(message: unknown, ...params: unknown[]): void {
    this.target.error({ context: contextOf(params) }, textOf(message));
  }

  public warn(message: unknown, ...params: unknown[]): void {
    this.target.warn({ context: contextOf(params) }, textOf(message));
  }

  public debug(message: unknown, ...params: unknown[]): void {
    this.target.debug({ context: contextOf(params) }, textOf(message));
  }

  public verbose(message: unknown, ...params: unknown[]): void {
    this.target.trace({ context: contextOf(params) }, textOf(message));
  }

  public fatal(message: unknown, ...params: unknown[]): void {
    this.target.fatal({ context: contextOf(params) }, textOf(message));
  }
}
