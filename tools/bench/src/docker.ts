import { spawn } from 'node:child_process';
import type { Docker, DockerRun } from './measure.js';
import { bytesOf, numberOf } from './stats.js';

/** Проект compose, которым поднят стенд: по его метке ищутся контейнеры и тома. */
const PROJECT = 'fieldstream';

/** Метки compose на контейнерах и томах стенда. */
const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';
const VOLUME_LABEL = 'com.docker.compose.volume';

/** Разделитель полей в шаблонах --format: ни в именах, ни в размерах, ни в метках его не бывает. */
const FIELD = '|';

/**
 * Предел ожидания одного запуска. Он выше предела запроса к базе (180 с), потому что выборки
 * идут через docker exec psql: иначе предел инструмента срубал бы запрос раньше базы.
 */
const RUN_LIMIT_MS = 240_000;

/** Код несостоявшегося запуска: docker не найден или прерван по пределу ожидания. */
const NO_RUN = -1;

/** Шаблоны вывода: поля через разделитель, разбор построчный, а не по человеческой таблице. */
export const SERVICES_FORMAT = `{{.Names}}${FIELD}{{.Label "${SERVICE_LABEL}"}}`;
export const STATS_FORMAT = `{{.Name}}${FIELD}{{.CPUPerc}}${FIELD}{{.MemUsage}}${FIELD}{{.MemPerc}}${FIELD}{{.PIDs}}`;
export const IMAGES_FORMAT = `{{.Repository}}${FIELD}{{.Tag}}${FIELD}{{.Size}}`;

/** Поля одного тома и обход списка: размеры томов docker считает только в system df -v. */
const VOLUME_FIELDS = `{{.Name}}${FIELD}{{.Size}}${FIELD}{{.Links}}${FIELD}{{.Labels}}{{println}}`;
export const VOLUMES_FORMAT = `{{range .Volumes}}${VOLUME_FIELDS}{{end}}`;

/** Контейнер стенда: имя контейнера и служба compose за ним. */
export interface ServiceContainer {
  readonly name: string;
  readonly service: string;
}

/** Снимок контейнера: доли от 0 до 1, размеры в байтах, непрочитанное поле это null. */
export interface ContainerStat {
  readonly name: string;
  readonly cpuShare: number | null;
  readonly memBytes: number | null;
  readonly limitBytes: number | null;
  readonly memShare: number | null;
  readonly pids: number | null;
}

/** Образ стенда: имя с меткой и размер, как его считает docker. */
export interface ImageSize {
  readonly reference: string;
  readonly bytes: number | null;
}

/** Том: полное имя, имя тома в compose, проект, размер и число контейнеров, которые его держат. */
export interface VolumeSize {
  readonly name: string;
  readonly volume: string | null;
  readonly project: string | null;
  readonly bytes: number | null;
  readonly links: number | null;
}

/** Непустые строки вывода docker. */
export const outLines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/** Поля строки по разделителю шаблона: строка без нужного числа полей не разбирается. */
export const fieldsOf = (line: string, count: number): string[] | null => {
  const parts = line.split(FIELD).map((part) => part.trim());

  return parts.length < count ? null : parts;
};

/** Доля из процента docker: 70.04% это 0.7004, прочерк и невнятное это null. */
export const shareOf = (text: string): number | null => {
  const matched = /^([0-9]+(?:\.[0-9]+)?)\s*%$/.exec(text.trim());
  if (matched === null) return null;

  const value = Number(matched[1]);
  return Number.isFinite(value) ? value / 100 : null;
};

/** Занятое и предел из поля MemUsage: 717.2MiB / 1GiB. */
export const usageOf = (
  text: string,
): { readonly used: number | null; readonly limit: number | null } => {
  const [used = '', limit = ''] = text.split('/');

  return { used: bytesOf(used), limit: bytesOf(limit) };
};

/** Метки docker печатает одной строкой через запятую. */
export const labelsOf = (text: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    text
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
      .map((item): [string, string] => {
        const at = item.indexOf('=');
        return at < 0 ? [item, ''] : [item.slice(0, at), item.slice(at + 1)];
      }),
  );

/** Вывод docker ps по шаблону SERVICES_FORMAT. */
export const parseServices = (text: string): ServiceContainer[] =>
  outLines(text).flatMap((line) => {
    const parts = fieldsOf(line, 2);
    if (parts === null) return [];

    const [name = '', service = ''] = parts;
    return name === '' ? [] : [{ name, service: service === '' ? name : service }];
  });

/** Вывод docker stats --no-stream по шаблону STATS_FORMAT. */
export const parseStats = (text: string): ContainerStat[] =>
  outLines(text).flatMap((line) => {
    const parts = fieldsOf(line, 5);
    if (parts === null) return [];

    const [name = '', cpu = '', usage = '', share = '', pids = ''] = parts;
    if (name === '') return [];

    const memory = usageOf(usage);
    return [
      {
        name,
        cpuShare: shareOf(cpu),
        memBytes: memory.used,
        limitBytes: memory.limit,
        memShare: shareOf(share),
        pids: numberOf(pids),
      },
    ];
  });

/** Вывод docker image ls по шаблону IMAGES_FORMAT. */
export const parseImages = (text: string): ImageSize[] =>
  outLines(text).flatMap((line) => {
    const parts = fieldsOf(line, 3);
    if (parts === null) return [];

    const [repository = '', tag = '', size = ''] = parts;
    return repository === '' ? [] : [{ reference: `${repository}:${tag}`, bytes: bytesOf(size) }];
  });

/** Вывод docker system df -v по шаблону VOLUMES_FORMAT. */
export const parseVolumes = (text: string): VolumeSize[] =>
  outLines(text).flatMap((line) => {
    const parts = fieldsOf(line, 4);
    if (parts === null) return [];

    const [name = '', size = '', links = '', labels = ''] = parts;
    if (name === '') return [];

    const marks = labelsOf(labels);
    return [
      {
        name,
        volume: marks[VOLUME_LABEL] ?? null,
        project: marks[PROJECT_LABEL] ?? null,
        bytes: bytesOf(size),
        links: numberOf(links),
      },
    ];
  });

/** Тома стенда среди всех томов хоста: у них стоит метка проекта compose. */
export const standVolumes = (volumes: readonly VolumeSize[], project: string): VolumeSize[] =>
  volumes.filter((volume) => volume.project === project);

/** Запущенные контейнеры проекта. */
export const containersArgs = (project: string): string[] => [
  'ps',
  '--filter',
  `label=${PROJECT_LABEL}=${project}`,
  '--format',
  SERVICES_FORMAT,
];

/** Контейнер одной службы проекта. */
export const serviceArgs = (project: string, service: string): string[] => [
  'ps',
  '--filter',
  `label=${PROJECT_LABEL}=${project}`,
  '--filter',
  `label=${SERVICE_LABEL}=${service}`,
  '--format',
  '{{.Names}}',
];

/** Снимок названных контейнеров: без --no-stream docker печатает поток, а не одну выборку. */
export const statsArgs = (names: readonly string[]): string[] => [
  'stats',
  '--no-stream',
  '--format',
  STATS_FORMAT,
  ...names,
];

/** Образы по имени: весь проект через fieldstream/*, один образ через полное имя с меткой. */
export const imagesArgs = (reference: string): string[] => [
  'image',
  'ls',
  reference,
  '--format',
  IMAGES_FORMAT,
];

/** Тома со счётом размеров. Без имени идут все тома хоста, с именем только один. */
export const volumesArgs = (name?: string): string[] => {
  const format =
    name === undefined
      ? VOLUMES_FORMAT
      : `{{range .Volumes}}{{if eq .Name "${name}"}}${VOLUME_FIELDS}{{end}}{{end}}`;

  return ['system', 'df', '-v', '--format', format];
};

/** Аргумент команды в одинарных кавычках: внутренняя кавычка закрывает строку и открывает снова. */
export const quoteArg = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** Аргумент команды для ручного повтора: всё сложнее простого слова идёт в одинарных кавычках. */
const shown = (arg: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : quoteArg(arg));

/** Команда docker строкой для ручного повтора. */
export const howOf = (args: readonly string[]): string => ['docker', ...args.map(shown)].join(' ');

/** Отказ запуска словами: команда, код возврата и первая внятная строка жалобы docker. */
export const failureText = (args: readonly string[], run: DockerRun): string => {
  const why = outLines(run.stderr)[0] ?? 'без объяснения';
  const hint = /error during connect|cannot connect to the docker daemon/i.test(why)
    ? ' Демон docker не отвечает: проверьте, что Docker запущен, а стенд поднят.'
    : '';
  const head =
    run.code === NO_RUN
      ? `${howOf(args)} не запустился`
      : `${howOf(args)} ответил кодом ${run.code}`;

  return `${head}: ${why}.${hint}`;
};

/** Почему запуск не состоялся: чаще всего docker просто не установлен в этой оболочке. */
const startFailure = (error: unknown): string => {
  const code: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : '';
  if (code === 'ENOENT') return 'docker не найден в PATH';

  return error instanceof Error ? error.message : String(error);
};

/**
 * Запуск docker: оба потока собираются целиком, отказ возвращается кодом, а не исключением.
 * Переданное окружение уходит порождаемому процессу, а не в его аргументы: аргументы видны
 * в списке процессов хоста любому пользователю, поэтому пароли передаются только так.
 */
const execute = (
  args: readonly string[],
  stdin?: string,
  env?: Readonly<Record<string, string>>,
): Promise<DockerRun> =>
  new Promise<DockerRun>((resolve) => {
    const child = spawn('docker', [...args], {
      timeout: RUN_LIMIT_MS,
      windowsHide: true,
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error: Error) => {
      resolve({ code: NO_RUN, stdout, stderr: `${stderr}\n${startFailure(error)}` });
    });
    child.on('close', (code, signal) => {
      if (code !== null) resolve({ code, stdout, stderr });
      else {
        const why = `прерван по пределу ожидания ${RUN_LIMIT_MS} мс, сигнал ${signal ?? 'неизвестен'}`;
        resolve({ code: NO_RUN, stdout, stderr: `${stderr}\n${why}` });
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin ?? '');
  });

/**
 * Запуск docker на хосте. Инструмент только читает состояние стенда: stats, image ls, system df
 * и exec с читающей командой. Останавливать, пересобирать и удалять что-либо нельзя, поэтому
 * таких вызовов в замерах нет. Подключений createDocker не открывает: docker проверяется первым
 * же запуском, и отсутствие docker в PATH или неподнятый стенд объясняются словами.
 */
export const createDocker = (): Docker => {
  const run = (
    args: readonly string[],
    stdin?: string,
    env?: Readonly<Record<string, string>>,
  ): Promise<DockerRun> => execute(args, stdin, env);

  const out = async (args: readonly string[], stdin?: string): Promise<string> => {
    const result = await run(args, stdin);
    if (result.code !== 0) throw new Error(failureText(args, result));

    return result.stdout;
  };

  const container = async (service: string): Promise<string> => {
    const [name] = outLines(await out(serviceArgs(PROJECT, service)));
    if (name === undefined) {
      throw new Error(
        `контейнер службы ${service} в проекте ${PROJECT} не найден: стенд поднят командой pnpm stack:up?`,
      );
    }

    return name;
  };

  return { project: PROJECT, run, out, how: howOf, container };
};
