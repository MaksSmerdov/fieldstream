import { readdir, readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import type { ZodIssue } from 'zod';
import { KEBAB_NAME_PATTERN, scenarioSchema } from './schema.js';
import type { Scenario } from './schema.js';

/** Каталог YAML-сценариев, который едет вместе с пакетом. */
export const SCENARIOS_DIR: URL = new URL('../scenarios/', import.meta.url);

/** Файл сценария: .yaml или .yml. */
const SCENARIO_FILE_PATTERN = /\.ya?ml$/;

/** Итог разбора одного файла сценария. */
export type ScenarioParseResult =
  | { readonly ok: true; readonly scenario: Scenario }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Сценарии не загрузились: в issues каждая проблема с именем файла и путём в схеме. */
export class ScenarioLoadError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`сценарии стенда описаны неверно:\n${issues.map((issue) => `  ${issue}`).join('\n')}`);
    this.name = 'ScenarioLoadError';
    this.issues = issues;
  }
}

/** Проблема схемы вида «dead-device.yaml: steps.2.waitFor.timeoutSec: текст». */
const formatIssue = (fileName: string, issue: ZodIssue): string =>
  issue.path.length === 0
    ? `${fileName}: ${issue.message}`
    : `${fileName}: ${issue.path.join('.')}: ${issue.message}`;

/** Файла нет на диске. */
const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** Разбирает текст сценария: разметка YAML, схема и совпадение имени с файлом. */
export const parseScenario = (fileName: string, text: string): ScenarioParseResult => {
  const document = parseDocument(text);

  if (document.errors.length > 0) {
    return {
      ok: false,
      issues: document.errors.map((error) => {
        const line = error.linePos?.[0].line;
        const where = line === undefined ? '' : `строка ${line}: `;
        const firstLine = error.message.split('\n')[0] ?? error.message;
        return `${fileName}: ${where}разметка YAML не разбирается: ${firstLine}`;
      }),
    };
  }

  const data: unknown = document.toJS();
  const expected = fileName.replace(SCENARIO_FILE_PATTERN, '');
  const issues: string[] = [];

  if (
    typeof data === 'object' &&
    data !== null &&
    'name' in data &&
    typeof data.name === 'string' &&
    data.name !== expected
  ) {
    issues.push(
      `${fileName}: name: «${data.name}» не совпадает с именем файла, ожидается «${expected}»`,
    );
  }

  const parsed = scenarioSchema.safeParse(data);
  if (!parsed.success) {
    issues.push(...parsed.error.issues.map((issue) => formatIssue(fileName, issue)));
  }

  if (!parsed.success || issues.length > 0) return { ok: false, issues };
  return { ok: true, scenario: parsed.data };
};

/** Загружает все сценарии каталога по порядку имён. Любая ошибка роняет загрузку целиком. */
export const loadScenarios = async (dir: URL = SCENARIOS_DIR): Promise<Scenario[]> => {
  const fileNames = (await readdir(dir))
    .filter((fileName) => SCENARIO_FILE_PATTERN.test(fileName))
    .sort((a, b) => a.localeCompare(b));
  const scenarios: Scenario[] = [];
  const issues: string[] = [];

  for (const fileName of fileNames) {
    const result = parseScenario(fileName, await readFile(new URL(fileName, dir), 'utf8'));
    if (result.ok) scenarios.push(result.scenario);
    else issues.push(...result.issues);
  }

  if (issues.length > 0) throw new ScenarioLoadError(issues);
  return scenarios;
};

/** Загружает один сценарий по имени. */
export const loadScenario = async (name: string, dir: URL = SCENARIOS_DIR): Promise<Scenario> => {
  if (!KEBAB_NAME_PATTERN.test(name)) {
    throw new ScenarioLoadError([`«${name}»: имя сценария пишется в kebab-case`]);
  }

  const fileName = `${name}.yaml`;
  let text: string;
  try {
    text = await readFile(new URL(fileName, dir), 'utf8');
  } catch (error) {
    if (isMissingFile(error)) throw new ScenarioLoadError([`${fileName}: сценария «${name}» нет`]);
    throw error;
  }

  const result = parseScenario(fileName, text);
  if (!result.ok) throw new ScenarioLoadError(result.issues);
  return result.scenario;
};
