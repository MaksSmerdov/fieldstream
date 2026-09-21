import { headingText } from './slug.js';

/** Ссылка из документа: куда ведёт, на какой строке и картинка ли это. */
export interface Link {
  readonly target: string;
  readonly line: number;
  readonly image: boolean;
}

/** Кусок текста с номером строки: заголовок или код в обратных кавычках. */
export interface Piece {
  readonly text: string;
  readonly line: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(`+)(.*?)\1/g;
const HEADING = /^ {0,3}#{1,6} +\S/;
const TARGET = /\]\(\s*(<[^>\n]*>|[^\s)]*)\s*(?:"[^"]*"|'[^']*')?\s*\)/g;
const DEFINITION = /^ {0,3}\[[^[\]\n]+\]:\s*(<[^>\n]*>|\S+)/;

/** Переводы строк приводятся к одному виду: номера строк должны сходиться с файлом на любой ОС. */
export const normalize = (text: string): string => text.replace(/\r\n/g, '\n');

/**
 * Блоки кода вырезаются, пустые строки на их месте остаются: иначе номера строк в отчёте
 * разойдутся с файлом. Без этого в README ссылкой считалась бы строка командной оболочки.
 */
export const stripFences = (text: string): string => {
  let fence: { readonly char: string; readonly length: number } | null = null;

  const lines = text.split('\n').map((line) => {
    const opening = FENCE.exec(line)?.[1];

    if (fence === null) {
      if (opening === undefined) return line;
      fence = { char: opening[0] ?? '`', length: opening.length };
      return '';
    }
    if (opening !== undefined && opening[0] === fence.char && opening.length >= fence.length) {
      fence = null;
    }
    return '';
  });

  return lines.join('\n');
};

/** Код в обратных кавычках заменяется пробелами: длина строк и их число не меняются. */
export const stripInlineCode = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.replace(INLINE_CODE, (match) => ' '.repeat(match.length)))
    .join('\n');

/** Код в обратных кавычках отдельными кусками: в нём ищутся упомянутые пути. */
export const collectCode = (text: string): Piece[] =>
  text
    .split('\n')
    .flatMap((line, index) =>
      [...line.matchAll(INLINE_CODE)].flatMap((match) =>
        match[2] === undefined || match[2] === '' ? [] : [{ text: match[2], line: index + 1 }],
      ),
    );

/** Заголовки документа по порядку: из них складываются якоря. */
export const collectHeadings = (text: string): Piece[] =>
  text
    .split('\n')
    .flatMap((line, index) =>
      HEADING.test(line) ? [{ text: headingText(line), line: index + 1 }] : [],
    );

/**
 * Начало метки ссылки: поиск открывающей скобки от закрывающей, с учётом вложенности.
 * Нужен, чтобы отличить картинку от ссылки и разобрать бейдж `[![Проверки](svg)](поток)`,
 * где ссылка обёрнута вокруг картинки.
 */
const labelStart = (text: string, closing: number): number => {
  let depth = 0;

  for (let index = closing; index >= 0; index -= 1) {
    if (text[index] === ']') depth += 1;
    else if (text[index] === '[') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

/** Номер строки по положению в тексте. */
const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** Адрес без угловых скобок вокруг него. */
const unwrap = (target: string): string =>
  target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;

/** Все ссылки документа: обычные, картинки и определения ссылок по метке в конце файла. */
export const collectLinks = (text: string): Link[] => {
  const inline = [...text.matchAll(TARGET)].flatMap((match) => {
    const closing = match.index;
    const start = labelStart(text, closing);

    return [
      {
        target: unwrap(match[1] ?? ''),
        line: lineAt(text, closing),
        image: start > 0 && text[start - 1] === '!',
      },
    ];
  });

  const defined = text.split('\n').flatMap((line, index) => {
    const target = DEFINITION.exec(line)?.[1];

    return target === undefined ? [] : [{ target: unwrap(target), line: index + 1, image: false }];
  });

  return [...inline, ...defined];
};
