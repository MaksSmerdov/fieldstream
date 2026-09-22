import { ApiError } from './http.js';

/**
 * Ошибка опроса хода, которую повтор не исправит: запроса нет, нет права или ответ не по
 * контракту. Временные отказы (нет ответа, 408, 429, 5xx) сюда не попадают — их опрос
 * переживает сам, и останавливать его из-за одного такого ответа незачем.
 */
export const isFatalPollError = (error: unknown): boolean => {
  if (error === null || error === undefined) return false;
  if (!(error instanceof ApiError)) return true;

  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
};
