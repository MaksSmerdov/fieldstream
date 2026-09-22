import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDocs } from '../src/check.js';
import type { Finding } from '../src/check.js';

/** Маленький репозиторий во временном каталоге: свои документы проверка не должна видеть. */
const FILES: Readonly<Record<string, string>> = {
  'docs/media/tour.gif': 'GIF',
  'tools/bench/src/main.ts': 'export {};\n',
  'docs/STAND.md': ['# Стенд', '', '## Замеры', '', '## Сценарии стенда'].join('\n'),
  'README.md': [
    '# Заголовок',
    '',
    '## Основные механизмы',
    '',
    '[![Проверки](../../actions/workflows/checks.yml/badge.svg)](../../actions/workflows/checks.yml)',
    '',
    '[внутрь себя](#основные-механизмы)',
    '[в соседний документ](docs/STAND.md#замеры)',
    '[в каталог](docs/media)',
    '![картинка](docs/media/tour.gif)',
    '[во внешнюю сеть](https://example.invalid/нет-такого)',
    '[почта](mailto:кто-то@example.com)',
    '',
    'Путь кодом: `tools/bench/src/main.ts`, не путь: `pnpm bench`, `tools/*/src/**/*.ts`.',
  ].join('\n'),
  'docs/broken.md': [
    '# Битый',
    '',
    '[нет файла](../docs/нет-такого.md)',
    '[нет якоря рядом](STAND.md#нет-такого-заголовка)',
    '[нет якоря у себя](#тоже-нет)',
    '[якорь у каталога](media#замеры)',
    '[якорь не у документа](../tools/bench/src/main.ts#замеры)',
    '![нет картинки](media/нет.png)',
    '[наружу](../../соседний-репозиторий/README.md)',
    '',
    'Упомянут `tools/нет-такого/src/main.ts`.',
  ].join('\n'),
};

let root = '';
let findings: readonly Finding[] = [];

const at = (file: string, line: number): Finding | undefined =>
  findings.find((finding) => finding.file === file && finding.line === line);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'docs-links-'));
  for (const [path, text] of Object.entries(FILES)) {
    const full = join(root, path);

    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text, 'utf8');
  }
  findings = (await checkDocs(root)).findings;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('проверка ссылок', () => {
  it('целые ссылки не считаются находками', () => {
    expect(findings.filter((finding) => finding.file === 'README.md')).toEqual([]);
  });

  it('ссылка на несуществующий путь', () => {
    expect(at('docs/broken.md', 3)?.why).toBe('путь не существует');
  });

  it('якорь, которому не отвечает заголовок соседнего документа', () => {
    expect(at('docs/broken.md', 4)?.why).toBe('в документе нет заголовка с таким якорем');
  });

  it('якорь, которому не отвечает заголовок своего документа', () => {
    expect(at('docs/broken.md', 5)?.why).toBe('в документе нет заголовка с таким якорем');
  });

  it('якорь у каталога и у файла, который не документ', () => {
    expect(at('docs/broken.md', 6)?.why).toBe('якорь указан у каталога');
    expect(at('docs/broken.md', 7)?.why).toBe('якорь указан у файла, который не документ');
  });

  it('картинка ведёт в пустоту', () => {
    expect(at('docs/broken.md', 8)?.why).toBe('путь не существует');
  });

  it('ссылка уходит за пределы репозитория', () => {
    expect(at('docs/broken.md', 9)?.why).toBe('ссылка уходит за пределы репозитория');
  });

  it('упомянутый кодом путь, которого нет', () => {
    const mention = at('docs/broken.md', 11);

    expect(mention?.what).toBe('tools/нет-такого/src/main.ts');
    expect(mention?.why).toBe('упомянутого пути не существует');
  });

  it('других находок нет: внешние адреса и бейджи GitHub не проверяются', () => {
    expect(findings).toHaveLength(8);
  });
});
