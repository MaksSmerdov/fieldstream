import { describe, expect, it } from 'vitest';
import { counted, plural } from '../src/shared/text/plural.js';

const REQUESTS: readonly [string, string, string] = ['запрос', 'запроса', 'запросов'];

describe('склонение по числу', () => {
  it('единица берёт первую форму, кроме одиннадцати', () => {
    expect(plural(1, REQUESTS)).toBe('запрос');
    expect(plural(21, REQUESTS)).toBe('запрос');
    expect(plural(11, REQUESTS)).toBe('запросов');
  });

  it('двойка, тройка и четвёрка берут вторую форму, кроме подростковых', () => {
    expect(plural(2, REQUESTS)).toBe('запроса');
    expect(plural(34, REQUESTS)).toBe('запроса');
    expect(plural(13, REQUESTS)).toBe('запросов');
  });

  it('ноль, пятёрка и остальное берут третью форму', () => {
    expect(plural(0, REQUESTS)).toBe('запросов');
    expect(plural(5, REQUESTS)).toBe('запросов');
    expect(plural(100, REQUESTS)).toBe('запросов');
  });

  it('число и слово собираются вместе', () => {
    expect(counted(5, REQUESTS)).toBe('5 запросов');
  });
});
