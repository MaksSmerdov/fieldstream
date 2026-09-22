/**
 * Правила GitHub: текст заголовка приводится к нижнему регистру, теги HTML выбрасываются,
 * знаки препинания и символы выбрасываются (дефис и подчёркивание остаются), пробелы становятся
 * дефисами. Буквы остаются любые, поэтому кириллический заголовок даёт кириллический якорь,
 * а «Что бы я сделал иначе» — якорь `что-бы-я-сделал-иначе`.
 */
const HTML_TAG = /<[!/a-z][^>]*>/gi;
const KEPT = /[^\p{L}\p{N}\p{M}\-_ ]/gu;

const INLINE_LINK = /!?\[([^[\]]*)\]\([^()]*\)/g;
const REFERENCE_LINK = /!?\[([^[\]]*)\](?:\[[^[\]]*\])?/g;
const OPENING_HASHES = /^ {0,3}#{1,6} +/;
const CLOSING_HASHES = /\s+#+\s*$/;

/** Якорь одного заголовка без учёта повторов. */
export const slugify = (heading: string): string =>
  heading.toLowerCase().trim().replace(HTML_TAG, '').replace(KEPT, '').replace(/ /g, '-');

/** Текст заголовка, каким его видит читатель: решётки и разметка ссылок убраны. */
export const headingText = (line: string): string =>
  line
    .replace(OPENING_HASHES, '')
    .replace(CLOSING_HASHES, '')
    .replace(INLINE_LINK, '$1')
    .replace(REFERENCE_LINK, '$1')
    .trim();

/**
 * Якоря всех заголовков документа по порядку. Повторный заголовок получает номер: второе
 * «Добавлено» в истории изменений — это якорь `добавлено-1`, третье — `добавлено-2`.
 */
export const collectSlugs = (headings: readonly string[]): string[] => {
  const seen = new Map<string, number>();

  return headings.map((heading) => {
    const base = slugify(heading);
    const taken = seen.get(base) ?? 0;

    seen.set(base, taken + 1);
    return taken === 0 ? base : `${base}-${String(taken)}`;
  });
};
