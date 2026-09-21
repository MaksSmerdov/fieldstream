import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import type { Link, Piece } from './markdown.js';
import {
  collectCode,
  collectHeadings,
  collectLinks,
  normalize,
  stripFences,
  stripInlineCode,
} from './markdown.js';
import { collectSlugs } from './slug.js';

/** Одна находка: где она и что с ней не так. */
export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly what: string;
  readonly why: string;
}

/** Итог прогона: сколько просмотрено и что нашлось. */
export interface CheckResult {
  readonly docs: number;
  readonly links: number;
  readonly mentions: number;
  readonly findings: readonly Finding[];
}

const SKIPPED_DIRS = new Set([
  '.git',
  '.turbo',
  'node_modules',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
]);

/** Корни репозитория, от которых пишутся пути в документах: прочий текст путями не считаем. */
const ROOT_DIRS = new Set(['.github', 'apps', 'docs', 'infra', 'packages', 'services', 'tools']);

/** Адрес во внешней сети. В сеть не ходим: чужой недоступный сайт не должен ронять проверку. */
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Ссылки, которые GitHub считает от адреса репозитория, а не от файла: бейджи рабочих потоков
 * вида `../../actions/workflows/...`, сравнения версий и метки выпусков в истории изменений.
 * Файлов с такими путями в репозитории нет и быть не должно, поэтому их пропускаем.
 */
const GITHUB_RELATIVE =
  /^(?:\.\.\/)+(?:actions|blob|commits|compare|issues|pull|releases|tree|wiki)\//;

/** Похоже на путь в репозитории: сегменты без пробелов, звёздочек и двоеточий. */
const PATH_LIKE = /^[\w.-]+(?:\/[\p{L}\p{N}._-]+)+$/u;

type Found = 'file' | 'dir' | 'none';

/** Все документы репозитория, кроме служебных каталогов. */
export const listDocs = async (root: string): Promise<string[]> => {
  const walk = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry): Promise<string[]> => {
        const full = resolve(dir, entry.name);

        if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : walk(full);
        return entry.isFile() && entry.name.endsWith('.md') ? [full] : [];
      }),
    );

    return nested.flat();
  };

  return (await walk(root)).sort((left, right) => left.localeCompare(right));
};

/** Путь для отчёта: от корня репозитория и через косую черту на любой ОС. */
const shown = (root: string, file: string): string => relative(root, file).split(sep).join('/');

/** Что лежит по пути: файл, каталог или ничего. Ответы запоминаются, ссылок на один путь много. */
const createExists = (): ((path: string) => Promise<Found>) => {
  const known = new Map<string, Promise<Found>>();

  return (path) => {
    const asked = known.get(path);
    if (asked !== undefined) return asked;

    const answer = stat(path).then<Found, Found>(
      (info) => (info.isDirectory() ? 'dir' : 'file'),
      () => 'none',
    );

    known.set(path, answer);
    return answer;
  };
};

/** Якоря документа. Считаются один раз: на один документ ссылаются из многих мест. */
const createSlugs = (): ((path: string) => Promise<ReadonlySet<string>>) => {
  const known = new Map<string, Promise<ReadonlySet<string>>>();

  return (path) => {
    const asked = known.get(path);
    if (asked !== undefined) return asked;

    const answer = readFile(path, 'utf8').then(
      (text) =>
        new Set(
          collectSlugs(collectHeadings(stripFences(normalize(text))).map((piece) => piece.text)),
        ),
    );

    known.set(path, answer);
    return answer;
  };
};

/** Путь внутри репозитория или вне его: ссылка наружу почти всегда опечатка в числе `../`. */
const inside = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

interface Context {
  readonly root: string;
  readonly file: string;
  readonly exists: (path: string) => Promise<Found>;
  readonly slugs: (path: string) => Promise<ReadonlySet<string>>;
}

/** Проверка одной ссылки: сначала путь, затем якорь внутри найденного документа. */
const checkLink = async (context: Context, link: Link): Promise<Finding[]> => {
  const { root, file } = context;
  const at = { file: shown(root, file), line: link.line, what: link.target };

  if (link.target === '') return [{ ...at, why: 'пустая ссылка' }];
  if (EXTERNAL.test(link.target) || GITHUB_RELATIVE.test(link.target)) return [];

  const [rawPath = '', ...rest] = link.target.split('#');
  const anchor = rest.join('#');
  let path = file;

  if (rawPath !== '') {
    const decoded = decodeURIComponent(rawPath);

    path = resolve(dirname(file), decoded);
    if (!inside(root, path)) return [{ ...at, why: 'ссылка уходит за пределы репозитория' }];

    const found = await context.exists(path);

    if (found === 'none') return [{ ...at, why: 'путь не существует' }];
    if (link.image && found !== 'file') return [{ ...at, why: 'картинка указывает на каталог' }];
    if (anchor !== '' && found !== 'file') return [{ ...at, why: 'якорь указан у каталога' }];
    if (anchor !== '' && !decoded.endsWith('.md')) {
      return [{ ...at, why: 'якорь указан у файла, который не документ' }];
    }
  }

  if (anchor === '') return [];

  const slugs = await context.slugs(path);

  return slugs.has(decodeURIComponent(anchor).toLowerCase())
    ? []
    : [{ ...at, why: 'в документе нет заголовка с таким якорем' }];
};

/** Проверка пути, упомянутого кодом в обратных кавычках: такой путь тоже должен существовать. */
const checkMention = async (context: Context, mention: Piece): Promise<Finding[]> => {
  const found = await context.exists(resolve(context.root, mention.text));

  if (found !== 'none') return [];

  return [
    {
      file: shown(context.root, context.file),
      line: mention.line,
      what: mention.text,
      why: 'упомянутого пути не существует',
    },
  ];
};

/** Пути из кода в обратных кавычках: берутся только те, что начинаются с каталога репозитория. */
const mentionsOf = (text: string): Piece[] =>
  collectCode(text).flatMap((piece) => {
    const [first = ''] = piece.text.split('/');

    return PATH_LIKE.test(piece.text) && ROOT_DIRS.has(first) ? [piece] : [];
  });

/** Проверка всех документов репозитория. */
export const checkDocs = async (root: string): Promise<CheckResult> => {
  const docs = await listDocs(root);
  const exists = createExists();
  const slugs = createSlugs();
  const findings: Finding[] = [];
  let links = 0;
  let mentions = 0;

  for (const file of docs) {
    const fenced = stripFences(normalize(await readFile(file, 'utf8')));
    const context: Context = { root, file, exists, slugs };
    const fileLinks = collectLinks(stripInlineCode(fenced));
    const filePaths = mentionsOf(fenced);

    links += fileLinks.length;
    mentions += filePaths.length;

    for (const link of fileLinks) findings.push(...(await checkLink(context, link)));
    for (const mention of filePaths) findings.push(...(await checkMention(context, mention)));
  }

  return { docs: docs.length, links, mentions, findings };
};
