import { describe, expect, it } from 'vitest';
import type { ByteOrder } from '@fieldstream/contracts';
import { bytesToWords, toWord, wordsToBytes } from './byte-order.js';
import type { ByteQuad, WordPair } from './byte-order.js';

const ORDERS: readonly ByteOrder[] = ['ABCD', 'DCBA', 'BADC', 'CDAB'];

describe('wordsToBytes', () => {
  const words: WordPair = [0x1234, 0x5678];
  const expected: Readonly<Record<ByteOrder, ByteQuad>> = {
    ABCD: [0x12, 0x34, 0x56, 0x78],
    DCBA: [0x78, 0x56, 0x34, 0x12],
    BADC: [0x34, 0x12, 0x78, 0x56],
    CDAB: [0x56, 0x78, 0x12, 0x34],
  };

  for (const order of ORDERS) {
    it(`раскладывает слова по порядку ${order}`, () => {
      expect(wordsToBytes(words, order)).toEqual(expected[order]);
    });
  }

  it('даёт четыре разные раскладки для несимметричной пары слов', () => {
    const layouts = ORDERS.map((order) => wordsToBytes(words, order).join('.'));
    expect(new Set(layouts).size).toBe(4);
  });

  it('CDAB это те же байты, что ABCD на переставленных словах', () => {
    expect(wordsToBytes(words, 'CDAB')).toEqual(wordsToBytes([words[1], words[0]], 'ABCD'));
  });

  it('BADC меняет байты внутри каждого слова, не трогая порядок слов', () => {
    expect(wordsToBytes(words, 'BADC')).toEqual(wordsToBytes([0x3412, 0x7856], 'ABCD'));
  });

  it('обрезает лишние разряды слова', () => {
    expect(wordsToBytes([0x11234, -1], 'ABCD')).toEqual([0x12, 0x34, 0xff, 0xff]);
  });
});

describe('bytesToWords', () => {
  const bytes: ByteQuad = [0x12, 0x34, 0x56, 0x78];
  const expected: Readonly<Record<ByteOrder, WordPair>> = {
    ABCD: [0x1234, 0x5678],
    DCBA: [0x7856, 0x3412],
    BADC: [0x3412, 0x7856],
    CDAB: [0x5678, 0x1234],
  };

  for (const order of ORDERS) {
    it(`собирает слова по порядку ${order}`, () => {
      expect(bytesToWords(bytes, order)).toEqual(expected[order]);
    });
  }

  it('всегда отдаёт слова в границах 16 бит', () => {
    for (const order of ORDERS) {
      for (const word of bytesToWords([0xff, 0xff, 0xff, 0xff], order)) {
        expect(word).toBe(0xffff);
      }
    }
  });
});

describe('обход туда и обратно', () => {
  const pairs: readonly WordPair[] = [
    [0x0000, 0x0000],
    [0xffff, 0xffff],
    [0x0001, 0x86a0],
    [0xfffe, 0x1dc0],
    [0x8000, 0x0001],
  ];

  for (const order of ORDERS) {
    it(`порядок ${order} обратим на паре слов`, () => {
      for (const pair of pairs) {
        expect(bytesToWords(wordsToBytes(pair, order), order)).toEqual(pair);
      }
    });
  }
});

describe('toWord', () => {
  it('приводит отрицательное значение к беззнаковому слову', () => {
    expect(toWord(-1)).toBe(0xffff);
    expect(toWord(-2)).toBe(0xfffe);
  });

  it('отбрасывает разряды выше шестнадцатого', () => {
    expect(toWord(0x1_0000)).toBe(0);
    expect(toWord(0x1_2345)).toBe(0x2345);
  });
});
