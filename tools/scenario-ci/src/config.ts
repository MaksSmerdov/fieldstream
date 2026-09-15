import { z } from 'zod';
import { scenarioNameSchema } from '@fieldstream/contracts';

/** Настройки прогона сценариев из CI. names null значит все сценарии стенда. */
export interface CiConfig {
  readonly baseUrl: string;
  readonly email: string;
  readonly password: string;
  readonly names: readonly string[] | null;
  readonly summaryPath: string | null;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: CiConfig }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Пустая переменная окружения читается как не заданная: так её оставляет CI. */
const blankAsMissing = (value: unknown): unknown => (value === '' ? undefined : value);

const envSchema = z.object({
  E2E_BASE_URL: z.preprocess(
    blankAsMissing,
    z.string().url('ожидается адрес вида http://localhost:8080').default('http://localhost:8080'),
  ),
  E2E_EMAIL: z.preprocess(
    blankAsMissing,
    z.string().email('ожидается почта учётной записи').default('engineer@fieldstream.local'),
  ),
  E2E_PASSWORD: z.preprocess(blankAsMissing, z.string().min(1).default('fieldstream')),
  SCENARIOS: z.preprocess(blankAsMissing, z.string().optional()),
  GITHUB_STEP_SUMMARY: z.preprocess(blankAsMissing, z.string().optional()),
});

/** Список через запятую без пустых элементов. */
const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

/** Имена сценариев: из аргументов командной строки, иначе из SCENARIOS. Пусто значит все. */
export const parseNames = (
  args: readonly string[],
  list: string | undefined,
): { readonly names: string[] | null; readonly issues: string[] } => {
  const positional = args.filter((arg) => arg !== '--');
  const raw = positional.length > 0 ? positional.flatMap(splitList) : splitList(list ?? '');
  if (raw.length === 0) return { names: null, issues: [] };

  const issues = raw
    .filter((name) => !scenarioNameSchema.safeParse(name).success)
    .map((name) => `«${name}»: имя сценария пишется в kebab-case, например dead-device`);

  return { names: [...new Set(raw)], issues };
};

/** Разбирает аргументы и окружение. Любая ошибка возвращается списком, а не исключением. */
export const parseConfig = (
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ConfigResult => {
  const parsed = envSchema.safeParse(env);
  const names = parseNames(args, parsed.success ? parsed.data.SCENARIOS : env['SCENARIOS']);
  const issues = [
    ...(parsed.success
      ? []
      : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)),
    ...names.issues,
  ];

  if (!parsed.success || issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    config: {
      baseUrl: parsed.data.E2E_BASE_URL.replace(/\/+$/, ''),
      email: parsed.data.E2E_EMAIL,
      password: parsed.data.E2E_PASSWORD,
      names: names.names,
      summaryPath: parsed.data.GITHUB_STEP_SUMMARY ?? null,
    },
  };
};

export type Selection<T> =
  { readonly ok: true; readonly scenarios: T[] } | { readonly ok: false; readonly issue: string };

/** Сценарии к прогону в запрошенном порядке. Без имён идут все в порядке стенда. */
export const selectScenarios = <T extends { readonly name: string }>(
  available: readonly T[],
  names: readonly string[] | null,
): Selection<T> => {
  const known = available.map((scenario) => scenario.name).join(', ');
  if (available.length === 0) return { ok: false, issue: 'на стенде нет ни одного сценария' };
  if (names === null) return { ok: true, scenarios: [...available] };

  const byName = new Map(available.map((scenario) => [scenario.name, scenario]));
  const missing = names.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    return { ok: false, issue: `на стенде нет сценариев ${missing.join(', ')}, есть: ${known}` };
  }

  return {
    ok: true,
    scenarios: names.flatMap((name) => {
      const scenario = byName.get(name);
      return scenario === undefined ? [] : [scenario];
    }),
  };
};
