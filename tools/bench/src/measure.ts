import type { Admin } from 'kafkajs';
import type { LiveEventKind, LiveFrame } from '@fieldstream/contracts';
import type { BenchConfig } from './config.js';

/** Имена замеров: они же аргументы командной строки, они же ключи реестра. */
export const MEASURE_NAMES = [
  'throughput',
  'latency',
  'lag',
  'memory',
  'images',
  'volumes',
  'compression',
  'query',
] as const;

export type MeasureName = (typeof MEASURE_NAMES)[number];

/** Имя из аргументов запуска это имя замера из реестра. */
export const isMeasureName = (value: string): value is MeasureName =>
  (MEASURE_NAMES as readonly string[]).includes(value);

/** Чем замер пользуется. Подключается и проверяется только заявленное. */
export type Resource = 'db' | 'kafka' | 'gateway' | 'docker';

/**
 * Строка итоговой таблицы. how это точная команда или SQL, которой ту же цифру снимают руками
 * без этого инструмента: цифра, которую нечем воспроизвести, в документацию не идёт, поэтому
 * поле обязательное и непустое. note это оговорка к цифре: окно, выборка, чего цифра не учитывает.
 */
export interface Row {
  readonly label: string;
  readonly value: string;
  readonly how: string;
  readonly note?: string;
}

/** Что снял замер: строки таблицы и общий вывод одной фразой. */
export interface MeasureResult {
  readonly rows: readonly Row[];
  readonly note?: string;
}

/**
 * Ячейки строки выборки. Всё приходит текстом, ровно как печатает сервер: числа разбирает сам
 * замер через numberOf, а отметки времени приводит к нужному виду в самом SQL (::text, to_char).
 * Так прямое подключение и psql в контейнере дают один и тот же результат.
 */
export type Cells = Readonly<Record<string, string | null>>;

/** Как инструмент дотянулся до базы: напрямую по сети или через psql в контейнере стенда. */
export type DbAccess = 'direct' | 'docker';

/**
 * Доступ к базе под ролью fs_api, которой разрешено только читать. SQL приходит готовым текстом
 * одним запросом, без подстановок: этот же текст уходит в how, поэтому он обязан быть таким,
 * какой человек вставит в psql. Значения в запрос вносит замер через literal.
 */
export interface Db {
  readonly access: DbAccess;
  readonly rows: <T extends Cells = Cells>(sql: string) => Promise<readonly T[]>;
  readonly how: (sql: string) => string;
  readonly close: () => Promise<void>;
}

/**
 * Администратор брокера, только чтение: описание групп, смещения, метаданные топиков. Писать
 * в боевые топики и трогать их группы нельзя. how складывает равнозначную команду штатной
 * утилиты брокера, например ('kafka-consumer-groups.sh', ['--describe', '--group', 'fs-processor']).
 */
export interface Broker {
  readonly admin: Admin;
  readonly how: (tool: string, args: readonly string[]) => string;
  readonly close: () => Promise<void>;
}

export type HttpMethod = 'GET' | 'POST';

/** Ответ шлюза. status null, если ответа нет: обрыв связи или предел ожидания. */
export interface GatewayReply {
  readonly status: number | null;
  readonly body: unknown;
  readonly error: string | null;
}

/** Кадр живого канала и момент приёма, уже приведённый к часам шлюза. */
export interface LiveSample {
  readonly frame: LiveFrame;
  readonly atMs: number;
}

/**
 * Что слушать в живом канале: ключи подписки, нужный вид кадров, сколько их ждать и как долго.
 * signal снимает ожидание досрочно: по нему прогон бросают с клавиатуры, не дожидаясь предела.
 */
export interface ListenOptions {
  readonly keys: readonly string[];
  readonly kind: LiveEventKind;
  readonly count: number;
  readonly limitMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Шлюз под учётной записью инженера. Часы контейнера и хоста расходятся, поэтому шлюз сам
 * сообщает своё время: заголовком x-server-time в каждом ответе и полем serverTime кадра hello.
 * offsetMs это поправка локальных часов по этим отметкам, now это текущий момент по часам шлюза,
 * и только в этой шкале имеет смысл сравнивать ts события с моментом его приёма. logout закрывает
 * заведённую входом сессию: иначе каждый прогон оставлял бы на стенде запись со сроком в месяц.
 */
export interface Gateway {
  readonly baseUrl: string;
  readonly email: string;
  readonly login: () => Promise<void>;
  readonly logout: () => Promise<boolean>;
  readonly request: (method: HttpMethod, path: string, body?: unknown) => Promise<GatewayReply>;
  readonly offsetMs: () => number;
  readonly now: () => number;
  readonly listen: (options: ListenOptions) => Promise<readonly LiveSample[]>;
  readonly howListen: (keys: readonly string[]) => string;
}

/** Чем кончился запуск docker: код возврата и оба потока. */
export interface DockerRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Запуск docker на хосте, только чтение состояния стенда: stats, image ls, system df, exec
 * с читающей командой. Останавливать, пересобирать и удалять что-либо нельзя. out отдаёт stdout
 * и бросает при ненулевом коде, how складывает ту же команду строкой для ручного повтора,
 * container ищет контейнер службы compose по метке проекта. env уходит в окружение порождаемого
 * процесса, а не в его аргументы: пароль в списке процессов хоста виден любому, окружение нет.
 */
export interface Docker {
  readonly project: string;
  readonly run: (
    args: readonly string[],
    stdin?: string,
    env?: Readonly<Record<string, string>>,
  ) => Promise<DockerRun>;
  readonly out: (args: readonly string[], stdin?: string) => Promise<string>;
  readonly how: (args: readonly string[]) => string;
  readonly container: (service: string) => Promise<string>;
}

/** Такт опроса одной линии: то, что нагрузочный режим меняет и обязан вернуть обратно. */
export interface LinePoll {
  readonly lineCode: string;
  readonly pollIntervalMs: number;
}

/**
 * Нагрузочный режим глазами замера: включён ли и какой такт наведён командой. Такт берётся
 * отсюда, а не из core.lines: команда line.set_poll_interval меняет такт только в памяти
 * сборщика, в таблице линий остаётся засеянное значение.
 */
export interface Load {
  readonly on: boolean;
  readonly pollIntervalMs: number | null;
}

/** Секундомер: сколько прошло с его создания, числом и человеческой строкой. */
export interface Timer {
  readonly ms: () => number;
  readonly text: () => string;
}

/**
 * Средства замера. Доступны только те, что замер заявил в needs: обращение к незаявленному
 * бросает исключение с объяснением. note и observe пишут в протокол по ходу дела, строки
 * таблицы возвращаются из run, а не печатаются. signal снимается при Ctrl+C: по нему замер
 * бросает ожидание, чтобы прогон успел вернуть стенд к прежнему такту.
 */
export interface Bench {
  readonly name: MeasureName;
  readonly config: BenchConfig;
  readonly load: Load;
  readonly signal: AbortSignal;
  readonly db: Db;
  readonly broker: Broker;
  readonly gateway: Gateway;
  readonly docker: Docker;
  readonly timer: () => Timer;
  readonly sleep: (ms: number) => Promise<void>;
  readonly note: (text: string) => void;
  readonly observe: (text: string) => void;
}

/**
 * Один замер. Файл src/measures/<name>.ts экспортирует ровно одну константу с именем замера
 * в camelCase от kebab-case (throughput, latency, lag, memory, images, volumes, compression,
 * query) и типом Measure, а реестр в src/measures/index.ts собирает их по ключу name.
 */
export interface Measure {
  readonly name: MeasureName;
  readonly title: string;
  readonly needs: readonly Resource[];
  readonly run: (bench: Bench) => Promise<MeasureResult>;
}
