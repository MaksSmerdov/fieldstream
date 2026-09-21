import { describe, expect, it } from 'vitest';
import {
  collectCode,
  collectHeadings,
  collectLinks,
  normalize,
  stripFences,
  stripInlineCode,
} from '../src/markdown.js';

const doc = [
  '# Заголовок',
  '',
  'Ссылка на [устройство](docs/ARCHITECTURE.md#роли) и картинка:',
  '',
  '![Обзор](docs/media/tour.gif)',
  '',
  '```sh',
  'curl http://localhost:8080 # [не ссылка](nowhere.md)',
  '```',
  '',
  'В строке кода `[тоже не ссылка](nowhere.md)` ничего нет.',
  '',
  '[![Проверки](../../actions/workflows/checks.yml/badge.svg)](../../actions/workflows/checks.yml)',
  '',
  '[0.7]: ../../compare/v0.6...v0.7',
].join('\n');

const links = collectLinks(stripInlineCode(stripFences(doc)));

describe('разбор документа', () => {
  it('переводы строк приводятся к одному виду', () => {
    expect(normalize('a\r\nb')).toBe('a\nb');
  });

  it('блок кода вырезается, но номера строк не съезжают', () => {
    const stripped = stripFences(doc).split('\n');

    expect(stripped).toHaveLength(doc.split('\n').length);
    expect(stripped[7]).toBe('');
    expect(stripped[10]).toContain('тоже не ссылка');
  });

  it('ссылки из блока кода и из обратных кавычек не считаются', () => {
    expect(links.map((link) => link.target)).not.toContain('nowhere.md');
  });

  it('у ссылки есть адрес и номер строки', () => {
    expect(links).toContainEqual({
      target: 'docs/ARCHITECTURE.md#роли',
      line: 3,
      image: false,
    });
  });

  it('картинка отличается от ссылки', () => {
    expect(links).toContainEqual({ target: 'docs/media/tour.gif', line: 5, image: true });
  });

  it('у бейджа считаются обе ссылки: и картинка, и то, куда ведёт обёртка', () => {
    const badge = links.filter((link) => link.line === 13);

    expect(badge).toEqual([
      { target: '../../actions/workflows/checks.yml/badge.svg', line: 13, image: true },
      { target: '../../actions/workflows/checks.yml', line: 13, image: false },
    ]);
  });

  it('определение ссылки по метке тоже считается ссылкой', () => {
    expect(links).toContainEqual({ target: '../../compare/v0.6...v0.7', line: 15, image: false });
  });

  it('адрес в угловых скобках разворачивается', () => {
    expect(collectLinks('[путь](<docs/файл с пробелом.md>)')).toEqual([
      { target: 'docs/файл с пробелом.md', line: 1, image: false },
    ]);
  });

  it('подпись после адреса не попадает в адрес', () => {
    expect(collectLinks('[путь](docs/STAND.md "Стенд")')).toEqual([
      { target: 'docs/STAND.md', line: 1, image: false },
    ]);
  });

  it('заголовки собираются с номерами строк, из блока кода — нет', () => {
    expect(collectHeadings(stripFences(doc))).toEqual([{ text: 'Заголовок', line: 1 }]);
  });

  it('код в обратных кавычках собирается отдельно', () => {
    expect(collectCode('путь `tools/bench` и `pnpm bench`')).toEqual([
      { text: 'tools/bench', line: 1 },
      { text: 'pnpm bench', line: 1 },
    ]);
  });
});
