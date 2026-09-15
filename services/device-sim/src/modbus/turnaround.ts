import { createRandom, hashString } from '../physics/random.js';

export interface TurnaroundOptions {
  readonly seed: string;
  readonly lineCode: string;
  readonly baseMs: number;
  readonly jitterMs: number;
}

/**
 * Задержка ответа прибора: постоянная часть и добавка round(jitter * r^3). Куб даёт малую
 * медиану и длинный хвост, последовательность задана сидом стенда и кодом линии.
 */
export const createTurnaround = (options: TurnaroundOptions): (() => number) => {
  const random = createRandom(hashString(`${options.seed}:turnaround:${options.lineCode}`));
  return () => options.baseMs + Math.round(options.jitterMs * random.next() ** 3);
};
