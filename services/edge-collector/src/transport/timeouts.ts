/** Обмен не завершился даже за жёсткий таймаут: клиент считается зависшим и пересоздаётся. */
export class HardTimeoutError extends Error {
  public readonly timeoutMs: number;

  public constructor(timeoutMs: number) {
    super(`обмен не завершился за ${String(timeoutMs)} мс`);
    this.name = 'HardTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** Жёсткий таймаут поверх библиотечного: вдвое больше мягкого плюс запас на планировщик. */
export const hardTimeoutMs = (requestTimeoutMs: number): number => requestTimeoutMs * 2 + 250;

/** Сторожевой таймер всего цикла: шесть интервалов опроса, но не меньше пяти минут. */
export const cycleWatchdogMs = (pollIntervalMs: number): number =>
  Math.max(pollIntervalMs * 6, 300_000);

/**
 * Гонка работы с таймером. Нужна потому, что клиентская библиотека умеет зависать так,
 * что её промис не завершается никогда, и мягкий таймаут библиотеки тогда тоже не спасает.
 */
export const withHardTimeout = <T>(work: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new HardTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([work, deadline]).finally(() => {
    clearTimeout(timer);
  });
};
