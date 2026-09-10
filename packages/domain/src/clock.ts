/**
 * Порт времени. Домен не читает системные часы сам: время приходит аргументом
 * или через этот порт, иначе реплей истории дал бы не тот результат, что боевой прогон.
 */
export interface Clock {
  now: () => number;
}

/** Часы, которыми управляет тест: время двигают руками, а не ожиданием. */
export interface FakeClock extends Clock {
  set: (ms: number) => void;
  advance: (deltaMs: number) => void;
}

/** Системные часы: единственная точка во всём репозитории, где читается Date.now. */
export const SystemClock: Clock = {
  now: (): number => {
    // eslint-disable-next-line no-restricted-syntax -- порт Clock и есть та самая разрешённая точка доступа к системным часам
    return Date.now();
  },
};

/** Создаёт управляемые часы для тестов. */
export const createFakeClock = (startMs = 0): FakeClock => {
  let current = startMs;

  return {
    now: (): number => current,
    set: (ms: number): void => {
      current = ms;
    },
    advance: (deltaMs: number): void => {
      current += deltaMs;
    },
  };
};

/** Переводит миллисекунды в ISO-время контрактов. */
export const toIsoTimestamp = (ms: number): string => new Date(ms).toISOString();
