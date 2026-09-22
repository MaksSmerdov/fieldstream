import { runBench } from './bench.js';
import { DEFAULT_LOAD_MS, parseConfig, parseOptions } from './config.js';
import { MEASURE_NAMES } from './measure.js';
import { MEASURES } from './measures/index.js';
import { errorText } from './report.js';

const NAME_WIDTH = 13;

/** Список замеров и флагов: печатается по -h и при неверных аргументах. */
const usage = (): string =>
  [
    'Замеры стенда: pnpm bench [замеры...]',
    '',
    'Замеры (без имён снимаются все):',
    ...MEASURE_NAMES.map((name) => `  ${name.padEnd(NAME_WIDTH)}${MEASURES[name].title}`),
    '',
    'Флаги:',
    '  --out <путь>     дописать итоговую таблицу Markdown в файл',
    '  --load           нагрузочный режим: сменить такт опроса линий на время замеров',
    `  --load-ms <мс>   такт нагрузочного режима, по умолчанию ${DEFAULT_LOAD_MS}, только с --load`,
    '  -h, --help       этот список',
    '',
    'Без --load инструмент стенд не меняет: только выборки из базы, чтение метаданных брокера',
    'и чтение состояния docker; сессия входа в шлюз закрывается в конце прогона. С --load такт',
    'возвращается к прежнему и при срыве замера, и при снятии прогона с клавиатуры.',
    '',
    'Окружение: BENCH_BASE_URL, BENCH_EMAIL, BENCH_PASSWORD, BENCH_WINDOW_MS, BENCH_SAMPLES,',
    'DATABASE_HOST, DATABASE_PORT, POSTGRES_DB, KAFKA_BROKERS, FS_API_PASSWORD (нужен только',
    'замерам по базе: throughput, compression, query).',
  ].join('\n');

/** Список отказов строками для потока ошибок. */
const issuesText = (title: string, issues: readonly string[]): string =>
  `bench: ${title}\n${issues.map((issue) => `  ${issue}`).join('\n')}\n`;

const parsedOptions = parseOptions(process.argv.slice(2));

if (!parsedOptions.ok) {
  process.stderr.write(
    `${issuesText('аргументы не разобраны', parsedOptions.issues)}\n${usage()}\n`,
  );
  process.exitCode = 1;
} else if (parsedOptions.options.help) {
  process.stdout.write(`${usage()}\n`);
} else {
  const parsedConfig = parseConfig(process.env);

  if (!parsedConfig.ok) {
    process.stderr.write(issuesText('неверное окружение', parsedConfig.issues));
    process.exitCode = 1;
  } else {
    try {
      process.exitCode = await runBench(parsedConfig.config, parsedOptions.options);
    } catch (error) {
      process.stderr.write(`bench: прогон не доведён до конца: ${errorText(error)}\n`);
      process.exitCode = 1;
    }
  }
}
