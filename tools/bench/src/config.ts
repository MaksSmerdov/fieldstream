import { z } from 'zod';
import { isMeasureName } from './measure.js';
import type { MeasureName } from './measure.js';

/** Куда ходить за базой: хост, порт и имя базы без пароля. */
export interface BenchTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
}

/**
 * Чего не хватает, когда пароль читающей роли не задан. Пароль нужен только замерам по базе,
 * поэтому проверяется он не здесь, а там, где известен состав прогона.
 */
export const NO_API_PASSWORD =
  'FS_API_PASSWORD не задан: пароль читающей роли fs_api берётся из .env стенда, ' +
  'значения по умолчанию у него нет, и без него замеры по базе не снимаются';

/** Настройки прогона из окружения. */
export interface BenchConfig {
  readonly baseUrl: string;
  readonly email: string;
  readonly password: string;
  readonly target: BenchTarget;
  readonly apiPassword: string | null;
  readonly brokers: readonly string[];
  readonly windowMs: number;
  readonly samples: number;
}

/** Такт нагрузочного режима по умолчанию: раз в секунду на линию. */
export const DEFAULT_LOAD_MS = 1_000;

/** Пределы такта опроса те же, что у команды line.set_poll_interval в контрактах. */
export const MIN_LOAD_MS = 1_000;
export const MAX_LOAD_MS = 600_000;

/** Разобранная командная строка. Пустой список имён значит все замеры. */
export interface BenchOptions {
  readonly names: readonly MeasureName[];
  readonly outPath: string | null;
  readonly load: boolean;
  readonly loadMs: number;
  readonly help: boolean;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: BenchConfig }
  | { readonly ok: false; readonly issues: readonly string[] };

export type OptionsResult =
  | { readonly ok: true; readonly options: BenchOptions }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Пустая переменная окружения читается как не заданная. */
const blankAsMissing = (value: unknown): unknown => (value === '' ? undefined : value);

const envSchema = z.object({
  BENCH_BASE_URL: z.preprocess(
    blankAsMissing,
    z.string().url('ожидается адрес вида http://localhost:8080').default('http://localhost:8080'),
  ),
  BENCH_EMAIL: z.preprocess(
    blankAsMissing,
    z.string().email('ожидается почта учётной записи').default('engineer@fieldstream.local'),
  ),
  BENCH_PASSWORD: z.preprocess(blankAsMissing, z.string().min(1).default('fieldstream')),
  DATABASE_HOST: z.preprocess(blankAsMissing, z.string().min(1).default('localhost')),
  DATABASE_PORT: z.preprocess(
    blankAsMissing,
    z.coerce.number().int().min(1).max(65_535).default(5432),
  ),
  POSTGRES_DB: z.preprocess(blankAsMissing, z.string().min(1).default('fieldstream')),
  FS_API_PASSWORD: z.preprocess(blankAsMissing, z.string().min(1).optional()),
  KAFKA_BROKERS: z.preprocess(blankAsMissing, z.string().min(1).default('localhost:29092')),
  BENCH_WINDOW_MS: z.preprocess(
    blankAsMissing,
    z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  ),
  BENCH_SAMPLES: z.preprocess(
    blankAsMissing,
    z.coerce.number().int().min(1).max(10_000).default(120),
  ),
});

/** Адреса брокеров списком через запятую. */
export const parseBrokers = (raw: string): string[] =>
  raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

/** Разбирает окружение. Любая ошибка возвращается списком, а не исключением. */
export const parseConfig = (env: Readonly<Record<string, string | undefined>>): ConfigResult => {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  }

  const brokers = parseBrokers(parsed.data.KAFKA_BROKERS);
  if (brokers.length === 0) return { ok: false, issues: ['KAFKA_BROKERS: список адресов пуст'] };

  return {
    ok: true,
    config: {
      baseUrl: parsed.data.BENCH_BASE_URL.replace(/\/+$/, ''),
      email: parsed.data.BENCH_EMAIL,
      password: parsed.data.BENCH_PASSWORD,
      target: {
        host: parsed.data.DATABASE_HOST,
        port: parsed.data.DATABASE_PORT,
        database: parsed.data.POSTGRES_DB,
      },
      apiPassword: parsed.data.FS_API_PASSWORD ?? null,
      brokers,
      windowMs: parsed.data.BENCH_WINDOW_MS,
      samples: parsed.data.BENCH_SAMPLES,
    },
  };
};

/** Значение флага, которое стоит следующим аргументом. */
const valueAt = (args: readonly string[], index: number): string | null => {
  const value = args[index];
  return value === undefined || value.startsWith('--') ? null : value;
};

/**
 * Разбирает командную строку: имена замеров и флаги --out, --load, --load-ms, -h. Без --load
 * инструмент стенд не меняет, поэтому такт в одиночку нагрузку не включает и считается ошибкой.
 */
export const parseOptions = (args: readonly string[]): OptionsResult => {
  const issues: string[] = [];
  const names: MeasureName[] = [];
  let outPath: string | null = null;
  let load = false;
  let loadMs: number | null = null;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';

    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--load') {
      load = true;
      continue;
    }
    if (arg === '--out') {
      const value = valueAt(args, index + 1);
      if (value === null) issues.push('--out: не указан путь к файлу');
      else outPath = value;
      index += 1;
      continue;
    }
    if (arg === '--load-ms') {
      const value = valueAt(args, index + 1);
      const parsed = value === null ? Number.NaN : Number(value);
      if (!Number.isInteger(parsed) || parsed < MIN_LOAD_MS || parsed > MAX_LOAD_MS) {
        issues.push(`--load-ms: ожидается целое от ${MIN_LOAD_MS} до ${MAX_LOAD_MS} мс`);
      } else {
        loadMs = parsed;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      issues.push(`${arg}: неизвестный флаг`);
      continue;
    }
    if (!isMeasureName(arg)) {
      issues.push(`${arg}: такого замера нет`);
      continue;
    }
    if (!names.includes(arg)) names.push(arg);
  }

  if (loadMs !== null && !load) {
    issues.push('--load-ms задан без --load: без --load инструмент стенд не меняет');
  }
  if (issues.length > 0) return { ok: false, issues };

  return { ok: true, options: { names, outPath, load, loadMs: loadMs ?? DEFAULT_LOAD_MS, help } };
};
