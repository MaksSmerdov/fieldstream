/** Источник псевдослучайных чисел в полуинтервале [0, 1). */
export interface Random {
  next: () => number;
}

/** Хеш FNV-1a: текстовый сид в 32-битное число. */
export const hashString = (text: string): number => {
  let value = 0x811c9dc5;

  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }

  return value;
};

/** Генератор mulberry32: для одного сида всегда одна и та же последовательность. */
export const createRandom = (seed: number): Random => {
  let state = seed >>> 0;

  return {
    next: (): number => {
      state = (state + 0x6d2b79f5) >>> 0;
      let mixed = Math.imul(state ^ (state >>> 15), state | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
    },
  };
};
