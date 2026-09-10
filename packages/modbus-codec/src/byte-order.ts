import type { ByteOrder } from '@fieldstream/contracts';

/** Пара регистров: слово 0 приходит по линии первым. */
export type WordPair = readonly [number, number];

/** Четыре байта 32-битной величины в логическом порядке: A старший, D младший. */
export type ByteQuad = readonly [number, number, number, number];

const byte = (value: number): number => value & 0xff;

/** Приведение к 16-битному слову регистра. */
export const toWord = (value: number): number => value & 0xffff;

/**
 * Пара слов в четыре байта величины.
 * Имя порядка описывает, какие байты лежат в линии: у CDAB первым словом идёт младшая половина.
 */
export const wordsToBytes = (words: WordPair, order: ByteOrder): ByteQuad => {
  const first = toWord(words[0]);
  const second = toWord(words[1]);
  const s0 = (first >>> 8) & 0xff;
  const s1 = first & 0xff;
  const s2 = (second >>> 8) & 0xff;
  const s3 = second & 0xff;

  switch (order) {
    case 'ABCD':
      return [s0, s1, s2, s3];
    case 'DCBA':
      return [s3, s2, s1, s0];
    case 'BADC':
      return [s1, s0, s3, s2];
    case 'CDAB':
      return [s2, s3, s0, s1];
  }
};

/** Четыре байта величины обратно в пару слов регистров. */
export const bytesToWords = (bytes: ByteQuad, order: ByteOrder): WordPair => {
  const a = byte(bytes[0]);
  const b = byte(bytes[1]);
  const c = byte(bytes[2]);
  const d = byte(bytes[3]);

  switch (order) {
    case 'ABCD':
      return [(a << 8) | b, (c << 8) | d];
    case 'DCBA':
      return [(d << 8) | c, (b << 8) | a];
    case 'BADC':
      return [(b << 8) | a, (d << 8) | c];
    case 'CDAB':
      return [(c << 8) | d, (a << 8) | b];
  }
};
