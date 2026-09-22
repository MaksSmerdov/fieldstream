import { appendFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { SystemClock, toIsoTimestamp } from '@fieldstream/domain';
import { NO_API_PASSWORD } from './config.js';
import type { BenchConfig, BenchOptions } from './config.js';
import { createDb } from './db.js';
import { createDocker } from './docker.js';
import { createGateway } from './gateway.js';
import { createBroker } from './kafka.js';
import { NO_LOAD, applyLoad } from './load.js';
import type { LoadHandle } from './load.js';
import { MEASURE_NAMES } from './measure.js';
import type {
  Bench,
  Broker,
  Db,
  Docker,
  Gateway,
  LinePoll,
  Load,
  Measure,
  MeasureName,
  Resource,
} from './measure.js';
import { MEASURES } from './measures/index.js';
import { createReport, errorText, formatTable, startTimer } from './report.js';
import { formatDuration } from './stats.js';
import type { HeadFacts, Outcome, Report, RunFacts, Section } from './report.js';

/** Прогон, брошенный с клавиатуры: причина срыва и что стало со стендом. */
const STOPPED = 'прогон прерван с клавиатуры';

/** Подключённые средства и причина, по которой средства нет. */
interface Ports {
  readonly db: Db | null;
  readonly broker: Broker | null;
  readonly gateway: Gateway | null;
  readonly docker: Docker | null;
  readonly why: ReadonlyMap<Resource, string>;
}

/** Замеры к прогону в порядке реестра. Без имён идут все восемь. */
export const selectMeasures = (names: readonly MeasureName[]): Measure[] => {
  const chosen: readonly MeasureName[] = names.length === 0 ? MEASURE_NAMES : names;

  return chosen.map((name) => MEASURES[name]);
};

/** Что нужно прогону: объединение нужд выбранных замеров и шлюз для нагрузочного режима. */
export const neededResources = (
  measures: readonly Measure[],
  load: boolean,
): ReadonlySet<Resource> => {
  const needed = new Set<Resource>(measures.flatMap((measure) => measure.needs));
  if (load) needed.add('gateway');
  if (needed.has('db')) needed.add('docker');

  return needed;
};

/** Средство, которого нет: обращение к незаявленному или неподключённому объясняет, почему. */
const absent = <T>(value: T | null, why: string): T => {
  if (value === null) throw new Error(why);
  return value;
};

/** Подключение нужных средств. Недоступное не валит прогон: замеры за ним просто пропускаются. */
const connect = async (
  config: BenchConfig,
  needed: ReadonlySet<Resource>,
  report: Report,
): Promise<Ports> => {
  const why = new Map<Resource, string>();
  const docker = createDocker();
  let usableDocker: Docker | null = null;
  let db: Db | null = null;
  let broker: Broker | null = null;
  let gateway: Gateway | null = null;

  if (needed.has('docker')) {
    try {
      const version = await docker.out(['version', '--format', '{{.Server.Version}}']);
      report.note(`docker ${version.trim()} отвечает, проект ${docker.project}`);
      usableDocker = docker;
    } catch (error) {
      why.set('docker', `docker недоступен: ${errorText(error)}`);
    }
  }

  if (needed.has('db')) {
    const password = config.apiPassword;
    if (password === null) why.set('db', NO_API_PASSWORD);
    else {
      try {
        db = await createDb({ target: config.target, password, docker, note: report.note });
      } catch (error) {
        why.set('db', errorText(error));
      }
    }
  }

  if (needed.has('kafka')) {
    try {
      broker = await createBroker({ brokers: config.brokers, docker, note: report.note });
    } catch (error) {
      why.set('kafka', errorText(error));
    }
  }

  if (needed.has('gateway')) {
    const client = createGateway(config.baseUrl, config);
    try {
      await client.login();
      report.note(`шлюз ${config.baseUrl} впустил ${config.email}`);
      gateway = client;
    } catch (error) {
      why.set('gateway', errorText(error));
    }
  }

  return { db, broker, gateway, docker: usableDocker, why };
};

/**
 * Уборка за прогоном: закрыть пул базы, клиента брокера и сессию входа. Вход в шлюз заводит
 * сессию на стенде со сроком в месяц, поэтому выход обязателен: иначе прогон, который сам себя
 * называет чтением, оставлял бы на стенде запись после каждого запуска.
 */
const disconnect = async (ports: Ports, report: Report): Promise<void> => {
  if (ports.db !== null) await ports.db.close().catch(() => undefined);
  if (ports.broker !== null) await ports.broker.close().catch(() => undefined);
  if (ports.gateway !== null) {
    const closed = await ports.gateway.logout().catch(() => false);
    report.note(
      closed
        ? 'сессия входа в шлюз закрыта: на стенде от прогона не осталось ничего'
        : 'сессия входа в шлюз не закрылась: она истечёт сама по сроку продления',
    );
  }
};

/** Средства одного замера: доступны только те, что он заявил в needs. */
const createBenchContext = (params: {
  readonly measure: Measure;
  readonly config: BenchConfig;
  readonly load: Load;
  readonly ports: Ports;
  readonly report: Report;
  readonly signal: AbortSignal;
}): Bench => {
  const { measure, ports } = params;
  const gate = (resource: Resource): string =>
    measure.needs.includes(resource)
      ? (ports.why.get(resource) ?? `средство ${resource} не подключено`)
      : `замер ${measure.name} не заявил ${resource} в needs`;

  return {
    name: measure.name,
    config: params.config,
    load: params.load,
    signal: params.signal,
    get db(): Db {
      return absent(measure.needs.includes('db') ? ports.db : null, gate('db'));
    },
    get broker(): Broker {
      return absent(measure.needs.includes('kafka') ? ports.broker : null, gate('kafka'));
    },
    get gateway(): Gateway {
      return absent(measure.needs.includes('gateway') ? ports.gateway : null, gate('gateway'));
    },
    get docker(): Docker {
      return absent(measure.needs.includes('docker') ? ports.docker : null, gate('docker'));
    },
    timer: startTimer,
    sleep: (ms) => delay(ms, undefined, { signal: params.signal }),
    note: params.report.note,
    observe: params.report.observe,
  };
};

/** Чего замеру не хватает: первое из заявленного, что не подключилось. */
const missingFor = (measure: Measure, ports: Ports): string | null => {
  for (const resource of measure.needs) {
    const reason = ports.why.get(resource);
    if (reason !== undefined) return reason;
  }

  return null;
};

/** Один замер: пропуск при недоступном средстве, иначе прогон с перехватом срыва. */
const runMeasure = async (params: {
  readonly measure: Measure;
  readonly config: BenchConfig;
  readonly load: Load;
  readonly ports: Ports;
  readonly report: Report;
  readonly signal: AbortSignal;
}): Promise<Section> => {
  const { measure, report } = params;
  const timer = startTimer();
  report.start(measure);

  const missing = missingFor(measure, params.ports);
  const outcome: Outcome = await (async (): Promise<Outcome> => {
    if (missing !== null) return { kind: 'skipped', why: missing };

    try {
      return { kind: 'done', result: await measure.run(createBenchContext(params)) };
    } catch (error) {
      return params.signal.aborted
        ? { kind: 'failed', why: `${STOPPED}: ожидание замера снято, цифры неполны` }
        : { kind: 'failed', why: errorText(error) };
    }
  })();

  const section: Section = {
    name: measure.name,
    title: measure.title,
    tookMs: timer.ms(),
    outcome,
  };
  report.finish(section);

  return section;
};

/** Замеры, которым окно замеров и выборка событий вообще о чём-то говорят. */
const TIMED: readonly MeasureName[] = ['throughput', 'latency'];

/**
 * Обстоятельства прогона, известные до подключения средств. В шапку идёт только то, что
 * к этому прогону относится: брокер при замерах по Kafka, окно при замерах по времени,
 * команда получения токена при обращениях к шлюзу.
 */
const headFactsOf = (
  config: BenchConfig,
  options: BenchOptions,
  measures: readonly Measure[],
  needed: ReadonlySet<Resource>,
): HeadFacts => {
  const credentials = `{\\"email\\":\\"${config.email}\\",\\"password\\":\\"\${BENCH_PASSWORD:-fieldstream}\\"}`;
  const timed = measures.some((measure) => TIMED.includes(measure.name));

  return {
    baseUrl: config.baseUrl,
    brokers: needed.has('kafka') ? config.brokers : null,
    window: timed
      ? `Окно замеров ${formatDuration(config.windowMs)}, выборка событий ${String(config.samples)}`
      : null,
    load: options.load
      ? `Нагрузочный режим включён: такт опроса линий ${String(options.loadMs)} мс, прежние такты возвращаются после замеров.`
      : 'Нагрузочный режим выключен: из стенда только читали, а сессия входа в шлюз закрывается в конце прогона.',
    tokenHow: needed.has('gateway')
      ? `TOKEN=$(curl -sS -X POST ${config.baseUrl}/api/auth/login ` +
        `-H 'content-type: application/json' -d "${credentials}" | jq -r .accessToken)`
      : null,
  };
};

/** Обстоятельства прогона целиком: к шапке добавляются момент снятия и способ доступа к базе. */
const factsOf = (head: HeadFacts, config: BenchConfig, ports: Ports): RunFacts => {
  const dbWord =
    ports.db === null
      ? 'не подключалась'
      : ports.db.access === 'direct'
        ? `напрямую на ${config.target.host}:${String(config.target.port)}`
        : 'через psql в контейнере стенда, порт базы наружу не опубликован';

  const { gateway } = ports;

  return {
    ...head,
    atIso: toIsoTimestamp(gateway === null ? SystemClock.now() : gateway.now()),
    clock: gateway === null ? 'по часам хоста' : 'по часам шлюза',
    dbAccess: dbWord,
  };
};

/**
 * Снятие прогона по SIGINT и SIGTERM. Без слушателя Ctrl+C убивает процесс до возврата такта,
 * и в нагрузочном режиме стенд остался бы лить десятикратный поток. Сигнал снимает ожидания
 * замеров, а возврат такта идёт уже после него, поэтому обработчик только помечает срыв.
 */
const watchSignals = (stop: AbortController, report: Report): (() => void) => {
  const onSignal = (signal: string): void => {
    if (stop.signal.aborted) return;
    report.note(`получен ${signal}: ${STOPPED}, стенд возвращается к прежнему такту`);
    stop.abort(new Error(STOPPED));
  };
  const onInt = (): void => {
    onSignal('SIGINT');
  };
  const onTerm = (): void => {
    onSignal('SIGTERM');
  };

  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

  return () => {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  };
};

/**
 * Прогон замеров. Стенд меняется только в нагрузочном режиме и только штатной командой смены
 * такта: прежние такты возвращаются в finally, даже если замер сорвался и даже если прогон
 * сняли с клавиатуры. Без --load инструмент стенд не трогает вовсе, а итоговая таблица
 * дописывается в файл только при --out.
 */
export const runBench = async (config: BenchConfig, options: BenchOptions): Promise<number> => {
  const report = createReport();
  const measures = selectMeasures(options.names);
  const needed = neededResources(measures, options.load);
  const total = startTimer();
  const head = headFactsOf(config, options, measures, needed);
  report.head(head, measures);

  const stop = new AbortController();
  const unwatch = watchSignals(stop, report);
  const ports = await connect(config, needed, report);
  let handle: LoadHandle | null = null;
  let lost: readonly LinePoll[] = [];
  const sections: Section[] = [];

  try {
    if (options.load) {
      const { gateway } = ports;
      if (gateway === null) {
        throw new Error(
          `нагрузочный режим просит шлюз, а его нет: ${ports.why.get('gateway') ?? 'причина неизвестна'}`,
        );
      }
      handle = await applyLoad({
        gateway,
        pollIntervalMs: options.loadMs,
        note: report.note,
        signal: stop.signal,
      });
    }

    const load = handle === null ? NO_LOAD : handle.load;
    const facts = factsOf(head, config, ports);

    for (const measure of measures) {
      sections.push(
        await runMeasure({ measure, config, load, ports, report, signal: stop.signal }),
      );
      if (stop.signal.aborted) break;
    }

    const table = formatTable(sections, facts);
    if (options.outPath !== null && stop.signal.aborted) {
      report.note(
        `итоговая таблица в ${options.outPath} не дописана: цифры оборванного прогона неполны`,
      );
    } else if (options.outPath !== null) {
      await appendFile(options.outPath, `${table}\n\n`);
      report.note(`итоговая таблица дописана в ${options.outPath}`);
    }
  } finally {
    if (handle !== null) lost = await handle.restore();
    await disconnect(ports, report);
    unwatch();
  }

  if (lost.length > 0) {
    report.note(
      `такт не вернулся на линиях ${lost.map((line) => line.lineCode).join(', ')}: ` +
        'стенд остался под наведённой нагрузкой, прогон считается сорванным',
    );
  }
  if (stop.signal.aborted) report.note(`${STOPPED}: оставшиеся замеры не снимались`);
  report.foot(total.text(), sections);

  return sections.every((section) => section.outcome.kind === 'done') &&
    lost.length === 0 &&
    !stop.signal.aborted
    ? 0
    : 1;
};
