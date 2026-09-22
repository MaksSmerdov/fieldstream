import pg from 'pg';
import { ROLES, connectionUrl } from '@fieldstream/db';
import type { BenchTarget } from './config.js';
import { quoteArg } from './docker.js';
import type { Cells, Db, Docker } from './measure.js';
import { errorText } from './report.js';

/** Служба базы в compose: её контейнер ищется по метке проекта. */
const DB_SERVICE = 'timescaledb';

const CONNECT_LIMIT_MS = 3_000;
const QUERY_LIMIT_MS = 180_000;

/** Разбор ответа сервера отключён: ячейки нужны ровно в том виде, в каком их печатает psql. */
const TEXT_TYPES = {
  getTypeParser:
    () =>
    (value: string): string =>
      value,
};

/** Значение в текст SQL: число как есть, строка в одинарных кавычках с их удвоением. */
export const literal = (value: string | number): string =>
  typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`;

/** Запрос одной строкой: в команду для ручного повтора перевод строки не влезает. */
export const oneLine = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

/**
 * Разбор вывода psql --csv. Пустая ячейка без кавычек это NULL, пустая в кавычках это пустая
 * строка: psql различает их только кавычками, и инструмент обязан различать так же.
 */
export const parseCsv = (text: string): (string | null)[][] => {
  const rows: (string | null)[][] = [];
  let row: (string | null)[] = [];
  let field = '';
  let quoted = false;
  let touched = false;
  let inQuotes = false;

  const pushField = (): void => {
    row.push(quoted ? field : field === '' ? null : field);
    field = '';
    quoted = false;
  };
  const pushRow = (): void => {
    pushField();
    if (touched) rows.push(row);
    row = [];
    touched = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';

    if (inQuotes) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else inQuotes = false;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      quoted = true;
      touched = true;
    } else if (char === ',') {
      pushField();
      touched = true;
    } else if (char === '\n') {
      pushRow();
    } else if (char !== '\r') {
      field += char;
      touched = true;
    }
  }
  if (touched) pushRow();

  return rows;
};

/** Таблица в строки выборки: первая строка вывода это заголовок с именами столбцов. */
export const cellsOf = (table: readonly (readonly (string | null)[])[]): Cells[] => {
  const [header, ...body] = table;
  if (header === undefined) return [];

  const names = header.map((name, index) => name ?? `column_${String(index + 1)}`);

  return body.map((line) =>
    Object.fromEntries(names.map((name, index) => [name, line[index] ?? null])),
  );
};

/** Команда psql для ручного повтора: сам запрос уходит в psql на вход, как и в инструменте. */
const psqlHow = (prefix: readonly string[], sql: string): string =>
  `printf '%s\\n' ${quoteArg(oneLine(sql))} | ${prefix.join(' ')}`;

/** Ключи psql: читающая роль, остановка на первой ошибке, вывод в CSV и запрос со входа. */
const psqlFlags = (database: string): string[] => [
  '-U',
  ROLES.api,
  '-d',
  database,
  '-v',
  'ON_ERROR_STOP=1',
  '--csv',
  '-f',
  '-',
];

/** Пул прямого подключения под читающей ролью fs_api. */
const createPool = (target: BenchTarget, password: string): pg.Pool =>
  new pg.Pool({
    connectionString: connectionUrl(target, ROLES.api, password),
    max: 2,
    types: TEXT_TYPES,
    connectionTimeoutMillis: CONNECT_LIMIT_MS,
    statement_timeout: QUERY_LIMIT_MS,
    application_name: 'fieldstream-bench',
  });

/** База по сети: годится, когда порт базы опубликован наружу. */
const directDb = (pool: pg.Pool, target: BenchTarget): Db => {
  const shown = [
    'PGPASSWORD="$FS_API_PASSWORD"',
    'psql',
    '-h',
    target.host,
    '-p',
    String(target.port),
    ...psqlFlags(target.database),
  ];

  return {
    access: 'direct',
    rows: async <T extends Cells = Cells>(sql: string): Promise<readonly T[]> => {
      const result = await pool.query<Record<string, string | null>>(sql);
      return result.rows as T[];
    },
    how: (sql) => psqlHow(shown, sql),
    close: () => pool.end(),
  };
};

/**
 * База через psql в контейнере стенда: запрос уходит на вход psql, ответ читается как CSV.
 * Пароль передаётся окружением самого docker (-e PGPASSWORD без значения), а не аргументом:
 * аргументы запущенного процесса видны в списке процессов хоста. Предел запроса ставится
 * через PGOPTIONS, иначе на этом пути его не было бы вовсе и тяжёлый EXPLAIN пережил бы
 * предел ожидания инструмента, продолжая грузить базу стенда.
 */
const dockerDb = (docker: Docker, container: string, target: BenchTarget, password: string): Db => {
  const flags = psqlFlags(target.database);
  const options = `-c statement_timeout=${QUERY_LIMIT_MS}`;
  const head = ['exec', '-i', '-e', 'PGPASSWORD', '-e'];
  const args = [...head, `PGOPTIONS=${options}`, container, 'psql', ...flags];
  const shown = [
    'docker',
    'exec',
    '-i',
    '-e',
    'PGPASSWORD="$FS_API_PASSWORD"',
    '-e',
    `PGOPTIONS='${options}'`,
    container,
    'psql',
    ...flags,
  ];

  return {
    access: 'docker',
    rows: async <T extends Cells = Cells>(sql: string): Promise<readonly T[]> => {
      const run = await docker.run(args, `${oneLine(sql)}\n`, { PGPASSWORD: password });
      if (run.code !== 0) {
        const why = oneLine(run.stderr);
        throw new Error(`psql ответил кодом ${run.code}: ${why === '' ? 'без объяснения' : why}`);
      }

      return cellsOf(parseCsv(run.stdout)) as T[];
    },
    how: (sql) => psqlHow(shown, sql),
    close: () => Promise.resolve(),
  };
};

/**
 * Доступ к базе. Стенд порт базы наружу не публикует: в infra/compose/docker-compose.yml у службы
 * timescaledb ports нет вовсе, наружу торчат только брокер и веб. Поэтому прямое подключение
 * сначала проверяется живым запросом, и, если его нет, замеры идут через psql в контейнере.
 * Оба способа дают ячейки одинаково текстом, так что замеры от выбранного способа не зависят.
 */
export const createDb = async (params: {
  readonly target: BenchTarget;
  readonly password: string;
  readonly docker: Docker;
  readonly note: (text: string) => void;
}): Promise<Db> => {
  const pool = createPool(params.target, params.password);
  const address = `${params.target.host}:${String(params.target.port)}`;

  try {
    await pool.query('SELECT 1');
    params.note(`база отвечает напрямую на ${address} под ролью ${ROLES.api}`);
    return directDb(pool, params.target);
  } catch (direct) {
    await pool.end().catch(() => undefined);

    try {
      const container = await params.docker.container(DB_SERVICE);
      params.note(
        `база на ${address} с хоста недоступна (${errorText(direct)}), ` +
          `замеры идут через psql в контейнере ${container}`,
      );
      return dockerDb(params.docker, container, params.target, params.password);
    } catch (viaDocker) {
      throw new Error(
        `база недоступна ни с хоста (${errorText(direct)}), ни через docker (${errorText(viaDocker)}). ` +
          'Порт базы наружу не опубликован, поэтому нужен доступный docker с поднятым стендом.',
      );
    }
  }
};
