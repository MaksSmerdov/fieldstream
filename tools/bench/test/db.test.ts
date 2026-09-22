import { describe, expect, it } from 'vitest';
import { cellsOf, literal, oneLine, parseCsv } from '../src/db.js';

describe('разбор вывода psql --csv', () => {
  it('первая строка это заголовок, остальные значения', () => {
    expect(parseCsv('n\n2116752\n')).toEqual([['n'], ['2116752']]);
  });

  it('пустая ячейка без кавычек это NULL, а в кавычках пустая строка', () => {
    expect(parseCsv('a,b,c\n,"",x\n')).toEqual([
      ['a', 'b', 'c'],
      [null, '', 'x'],
    ]);
  });

  it('запятая и перевод строки внутри кавычек ячейку не делят', () => {
    expect(parseCsv('plan\n"Seq Scan, rows=1\nFilter: true"\n')).toEqual([
      ['plan'],
      ['Seq Scan, rows=1\nFilter: true'],
    ]);
  });

  it('удвоенная кавычка внутри значения читается как одна', () => {
    expect(parseCsv('q\n"он сказал ""да"""\n')).toEqual([['q'], ['он сказал "да"']]);
  });

  it('последняя строка без перевода строки не теряется, а пустая не выдумывается', () => {
    expect(parseCsv('a\n1')).toEqual([['a'], ['1']]);
    expect(parseCsv('a\n1\n\n')).toEqual([['a'], ['1']]);
    expect(parseCsv('')).toEqual([]);
  });
});

describe('строки выборки', () => {
  it('складываются из заголовка и значений', () => {
    expect(cellsOf(parseCsv('device,n\nRC-101,42\nRC-102,\n'))).toEqual([
      { device: 'RC-101', n: '42' },
      { device: 'RC-102', n: null },
    ]);
  });

  it('без заголовка строк нет', () => {
    expect(cellsOf([])).toEqual([]);
  });
});

describe('подстановка значений и команда повтора', () => {
  it('число идёт как есть, строка в кавычках с их удвоением', () => {
    expect(literal(60_000)).toBe('60000');
    expect(literal('RC-101')).toBe("'RC-101'");
    expect(literal("O'Hara")).toBe("'O''Hara'");
  });

  it('запрос для повтора складывается в одну строку', () => {
    expect(oneLine('  SELECT count(*)\n  FROM ts.readings\n')).toBe(
      'SELECT count(*) FROM ts.readings',
    );
  });
});
