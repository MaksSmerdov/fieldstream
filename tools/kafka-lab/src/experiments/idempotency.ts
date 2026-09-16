import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Consumer } from 'kafkajs';
import type { Experiment, Lab } from '../experiment.js';

/** База стенда наружу не опубликована, поэтому запросы идут ролью читателя внутрь контейнера. */
const DB_CONTAINER = 'fieldstream-timescaledb-1';
const DB_ROLE = 'fs_api';
const DB_NAME = 'fieldstream';
const NULL_MARK = '\\N';

const KEYED_TABLE = 'lab_readings';
const PLAIN_TABLE = 'lab_readings_plain';
const SAMPLE_SIZE = 240;
const DELIVERY_LIMIT_MS = 60_000;

/** Показание в том же наборе полей, что строка ts.readings и ReadingRow в packages/db. */
interface Reading {
  readonly ts: string;
  readonly deviceId: number;
  readonly metricKey: string;
  readonly value: number | null;
  readonly quality: number;
}

/** Счётчики приёмника: сколько пришло и сколько из этого стало строками. */
interface Sink {
  delivered: number;
  batches: number;
  keyed: number;
  plain: number;
  failed: string | null;
}

/** Сессия psql: живёт весь прогон, поэтому временные таблицы видны на всех шагах. */
interface DbSession {
  readonly rows: (sql: string) => Promise<string[][]>;
  readonly row: (sql: string) => Promise<string[]>;
  readonly value: (sql: string) => Promise<string>;
  readonly count: (sql: string) => Promise<number>;
  readonly exec: (sql: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

/** Ожидание одного ответа psql: метка отделяет вывод запроса от вывода следующего. */
interface Waiter {
  readonly mark: string;
  readonly resolve: (lines: string[]) => void;
  readonly reject: (error: Error) => void;
}

/** Строковый литерал SQL: кавычка внутри значения удваивается. */
const quoted = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Массив для unnest: значения уже приведены к литералам своего типа. */
const arrayOf = (values: readonly string[], type: string): string =>
  `ARRAY[${values.join(',')}]::${type}[]`;

/** Число или NULL как литерал SQL. */
const numberOf = (value: number | null): string => (value === null ? 'NULL' : String(value));

/** Разбор сообщения учебного топика: непонятный формат это отказ опыта, а не потерянная строка. */
const toReading = (raw: Buffer | null): Reading => {
  if (raw === null) throw new Error('в учебном топике сообщение без тела');

  const parsed: unknown = JSON.parse(raw.toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('показание не объект');

  const item = parsed as Record<string, unknown>;
  const { ts, deviceId, metricKey, value, quality } = item;
  if (
    typeof ts !== 'string' ||
    typeof deviceId !== 'number' ||
    typeof metricKey !== 'string' ||
    typeof quality !== 'number' ||
    !(value === null || typeof value === 'number')
  ) {
    throw new Error(`показание с неожиданными полями: ${raw.toString('utf8').slice(0, 120)}`);
  }

  return { ts, deviceId, metricKey, value, quality };
};

/** Подключение к базе стенда ролью читателя одной живой сессией psql. */
const openDb = async (): Promise<DbSession> => {
  const child: ChildProcessWithoutNullStreams = spawn('docker', [
    'exec',
    '-i',
    DB_CONTAINER,
    'psql',
    '-U',
    DB_ROLE,
    '-d',
    DB_NAME,
    '-X',
    '-q',
    '-A',
    '-t',
    '-P',
    `null=${NULL_MARK}`,
    '-v',
    'ON_ERROR_STOP=1',
    '-f',
    '-',
  ]);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let buffer = '';
  let complaint = '';
  let waiter: Waiter | null = null;
  let closed = false;
  let asked = 0;

  const fail = (error: Error): void => {
    const current = waiter;
    waiter = null;
    current?.reject(error);
  };

  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (waiter === null) return;

    const at = buffer.indexOf(waiter.mark);
    if (at < 0) return;

    const head = buffer.slice(0, at);
    buffer = buffer.slice(at + waiter.mark.length);
    const current = waiter;
    waiter = null;
    current.resolve(
      head
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line !== ''),
    );
  });
  child.stderr.on('data', (chunk: string) => {
    complaint += chunk;
  });
  child.stdin.on('error', (error: Error) => {
    complaint += `\n${error.message}`;
  });
  child.on('error', (error: Error) => {
    closed = true;
    fail(new Error(`docker не запустился: ${error.message}`));
  });
  child.on('close', () => {
    closed = true;
    fail(new Error(`сессия базы оборвалась: ${complaint.trim()}`));
  });

  const ask = async (sql: string): Promise<string[]> => {
    if (closed) throw new Error(`сессия базы закрыта: ${complaint.trim()}`);
    if (waiter !== null) throw new Error('к базе стенда идут два запроса разом');

    asked += 1;
    const mark = `<<фрагмент-${asked}>>`;
    return new Promise<string[]>((resolve, reject) => {
      waiter = { mark, resolve, reject };
      child.stdin.write(`${sql}\n\\echo ${mark}\n`);
    });
  };

  const rows = async (sql: string): Promise<string[][]> =>
    (await ask(sql)).map((line) => line.split('|'));

  const row = async (sql: string): Promise<string[]> => {
    const [first] = await rows(sql);
    if (first === undefined) throw new Error(`база стенда не вернула строк: ${sql.slice(0, 80)}`);
    return first;
  };

  const session: DbSession = {
    rows,
    row,
    value: async (sql) => (await row(sql))[0] ?? '',
    count: async (sql) => Number(await session.value(sql)),
    exec: async (sql) => {
      await ask(sql);
    },
    close: async () => {
      if (closed) return;
      child.stdin.end();
      await new Promise<void>((resolve) => {
        child.once('close', () => {
          resolve();
        });
      });
    },
  };

  try {
    await session.value('SELECT 1;');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `база стенда недоступна: ${reason}. Опыт ходит в контейнер ${DB_CONTAINER} ролью ${DB_ROLE}, ` +
        'стенд должен быть поднят (pnpm stack:up)',
    );
  }

  return session;
};

/** Настоящие показания из базы стенда: берутся только чтением и дальше идут через топик. */
const readSample = async (db: DbSession, limit: number): Promise<Reading[]> => {
  const rows = await db.rows(
    `SELECT ts, device_id, metric_key, value, quality
       FROM ts.readings
      WHERE ts >= (SELECT max(ts) FROM ts.readings) - INTERVAL '2 minutes'
      ORDER BY ts, device_id, metric_key
      LIMIT ${limit};`,
  );

  return rows.map((cells) => {
    const [ts, deviceId, metricKey, value, quality] = cells;
    if (ts === undefined || deviceId === undefined || metricKey === undefined) {
      throw new Error('показание из базы без обязательных полей');
    }
    return {
      ts,
      deviceId: Number(deviceId),
      metricKey,
      value: value === undefined || value === NULL_MARK ? null : Number(value),
      quality: Number(quality ?? 0),
    };
  });
};

/**
 * Запись пачки показаний тем же запросом, что и рабочий приёмник в packages/db: одна вставка
 * через unnest с ON CONFLICT DO NOTHING. Возвращает число реально появившихся строк.
 */
const insertBatch = async (
  db: DbSession,
  table: string,
  rows: readonly Reading[],
): Promise<number> => {
  if (rows.length === 0) return 0;

  return db.count(
    `WITH batch AS (
       INSERT INTO ${table} (ts, device_id, metric_key, value, quality)
       SELECT * FROM unnest(
         ${arrayOf(
           rows.map((item) => quoted(item.ts)),
           'timestamptz',
         )},
         ${arrayOf(
           rows.map((item) => String(item.deviceId)),
           'int',
         )},
         ${arrayOf(
           rows.map((item) => quoted(item.metricKey)),
           'text',
         )},
         ${arrayOf(
           rows.map((item) => numberOf(item.value)),
           'float8',
         )},
         ${arrayOf(
           rows.map((item) => String(item.quality)),
           'smallint',
         )})
       ON CONFLICT DO NOTHING
       RETURNING 1
     )
     SELECT count(*) FROM batch;`,
  );
};

/** Приёмник учебного топика: полученную пачку пишет в обе таблицы и считает вставленные строки. */
const startSink = async (lab: Lab, db: DbSession, topic: string, sink: Sink): Promise<Consumer> => {
  const consumer = await lab.consumer('sink');
  await consumer.subscribe({ topic, fromBeginning: true });
  await consumer.run({
    eachBatch: async ({ batch }) => {
      if (batch.messages.length === 0) return;

      try {
        const rows = batch.messages.map((message) => toReading(message.value));
        const keyed = await insertBatch(db, KEYED_TABLE, rows);
        const plain = await insertBatch(db, PLAIN_TABLE, rows);
        sink.keyed += keyed;
        sink.plain += plain;
        sink.batches += 1;
        sink.delivered += rows.length;
      } catch (error) {
        sink.failed = error instanceof Error ? error.message : String(error);
      }
    },
  });

  return consumer;
};

/** Ожидание доставки: отказ приёмника прекращает ожидание сразу, а не по истечении предела. */
const awaitDelivered = async (lab: Lab, sink: Sink, expected: number): Promise<void> => {
  await lab.waitFor(
    `приёмник получил ${expected} сообщений`,
    () => {
      if (sink.failed !== null) throw new Error(`приёмник не справился: ${sink.failed}`);
      return sink.delivered >= expected;
    },
    { limitMs: DELIVERY_LIMIT_MS },
  );
};

/** Сколько сообщений лежит в топике: сумма верхних границ по партициям. */
const topicSize = async (lab: Lab, topic: string): Promise<number> => {
  const offsets = await lab.admin.fetchTopicOffsets(topic);
  return offsets.reduce((sum, partition) => sum + Number(partition.high), 0);
};

/** Подтверждённое смещение группы по топику: отрицательная отметка это начало топика. */
const committedOffset = async (lab: Lab, groupId: string, topic: string): Promise<number> => {
  const [entry] = await lab.admin.fetchOffsets({ groupId, topics: [topic] });
  const bounds = await lab.admin.fetchTopicOffsets(topic);

  return (entry?.partitions ?? []).reduce((sum, partition) => {
    const offset = Number(partition.offset);
    const low = Number(bounds.find((item) => item.partition === partition.partition)?.low ?? 0);
    return sum + (offset < 0 ? low : offset);
  }, 0);
};

/** Сообщения учебного топика: ключ как в телеметрии, прибор и метрика. */
const messagesOf = (rows: readonly Reading[]): { key: string; value: string }[] =>
  rows.map((row) => ({
    key: `${row.deviceId}:${row.metricKey}`,
    value: JSON.stringify(row),
  }));

/** Опыт: идемпотентность приёмника при повторе. */
export const idempotency: Experiment = {
  name: 'idempotency',
  title: 'идемпотентность приёмника при повторе',
  run: async (lab) => {
    const db = await openDb();

    try {
      lab.step('смотрю ролью читателя, чем боевая таблица показаний защищена от повтора');
      const indexDef = await db.value(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'ts' AND tablename = 'readings' AND indexdef LIKE '%UNIQUE%';`,
      );
      lab.observe(indexDef);
      lab.note(
        'это и есть ключ идемпотентности: (прибор, метрика, время). ' +
          'Запись идёт пачкой через unnest с ON CONFLICT DO NOTHING (packages/db/src/store/writer.ts)',
      );

      lab.step('беру настоящую пачку показаний из базы стенда, только чтением');
      const sample = await readSample(db, SAMPLE_SIZE);
      const first = sample.at(0);
      const last = sample.at(-1);
      if (first === undefined || last === undefined) {
        throw new Error('в ts.readings нет свежих показаний: стенд засеян и сервисы подняты?');
      }
      const devices = new Set(sample.map((row) => row.deviceId)).size;
      const metrics = new Set(sample.map((row) => row.metricKey)).size;
      lab.observe(
        `${sample.length} показаний, приборов ${devices}, метрик ${metrics}, ` +
          `время с ${first.ts} по ${last.ts}`,
      );

      lab.step('складываю ту же пачку в учебный топик идемпотентным продюсером');
      const topic = await lab.topic('readings');
      const producer = await lab.producer({ idempotent: true });
      const messages = messagesOf(sample);
      await producer.send({ topic, messages });
      lab.observe(`в топике ${await topicSize(lab, topic)} сообщений`);

      lab.step('приёмник читает пачку и пишет её так же, как рабочий код');
      await db.exec(
        `CREATE TEMP TABLE ${KEYED_TABLE} (
           ts timestamptz NOT NULL,
           device_id integer NOT NULL,
           metric_key text NOT NULL,
           value double precision,
           quality smallint NOT NULL DEFAULT 0);
         CREATE UNIQUE INDEX ${KEYED_TABLE}_device_metric_ts
           ON ${KEYED_TABLE} (device_id, metric_key, ts DESC);
         CREATE TEMP TABLE ${PLAIN_TABLE} (LIKE ${KEYED_TABLE});`,
      );
      lab.note(
        `таблица ${KEYED_TABLE} повторяет ts.readings вместе с уникальным индексом, ` +
          `${PLAIN_TABLE} тот же набор полей без ключа. Обе временные, в боевые таблицы опыт не пишет`,
      );

      const sink: Sink = { delivered: 0, batches: 0, keyed: 0, plain: 0, failed: null };
      const group = lab.groupId('sink');
      const firstPass = await startSink(lab, db, topic, sink);
      await awaitDelivered(lab, sink, sample.length);
      lab.observe(
        `доставлено ${sink.delivered} сообщений пачками: ${sink.batches}, ` +
          `вставлено строк ${sink.keyed}, в таблице ${await db.count(`SELECT count(*) FROM ${KEYED_TABLE};`)}`,
      );

      lab.step('повторяю доставку: приёмник как будто упал между записью и подтверждением');
      await firstPass.stop();
      await firstPass.disconnect();
      await lab.waitFor('группа отпустила партиции', async () => {
        const described = await lab.admin.describeGroups([group]);
        return described.groups.at(0)?.state === 'Empty';
      });
      const committed = await committedOffset(lab, group, topic);
      await lab.admin.resetOffsets({ groupId: group, topic, earliest: true });
      lab.observe(
        `смещение группы было ${committed}, после сброса ${await committedOffset(lab, group, topic)}`,
      );

      const beforeRepeat = sink.keyed;
      await startSink(lab, db, topic, sink);
      await awaitDelivered(lab, sink, sample.length * 2);
      lab.observe(
        `пачка пришла второй раз: доставлено ${sink.delivered} сообщений, ` +
          `вставлено за повтор ${sink.keyed - beforeRepeat} строк, ` +
          `в таблице ${await db.count(`SELECT count(*) FROM ${KEYED_TABLE};`)}`,
      );

      lab.step('повторяю отправку: та же пачка уходит в топик ещё раз');
      const beforeResend = sink.keyed;
      await producer.send({ topic, messages });
      await awaitDelivered(lab, sink, sample.length * 3);
      lab.observe(
        `в топике ${await topicSize(lab, topic)} сообщений, идемпотентный продюсер копии не отбросил`,
      );
      lab.observe(
        `вставлено за третью доставку ${sink.keyed - beforeResend} строк, ` +
          `в таблице ${await db.count(`SELECT count(*) FROM ${KEYED_TABLE};`)}`,
      );
      lab.observe(
        `в такой же таблице без уникального ключа ` +
          `${await db.count(`SELECT count(*) FROM ${PLAIN_TABLE};`)} строк при ${sink.delivered} доставленных`,
      );

      lab.step('сверяю с боевой таблицей: там тот же ключ и тот же поток повторов');
      const [total, unique] = await db.row(
        `SELECT count(*), count(DISTINCT (device_id, metric_key, ts))
           FROM ts.readings
          WHERE ts >= (SELECT max(ts) FROM ts.readings) - INTERVAL '1 hour';`,
      );
      lab.observe(
        `ts.readings за последний час: строк ${total ?? '?'}, ` +
          `различных троек (прибор, метрика, время) ${unique ?? '?'}`,
      );

      lab.conclude(
        `одна и та же пачка прошла ${sink.delivered / sample.length} раза и дала ${sink.keyed} строк ` +
          `вместо ${sink.delivered}: лишнее срезал уникальный индекс, а не брокер. ` +
          'Идемпотентный продюсер снимает только дубли своих же повторов внутри отправки, ' +
          'повторное чтение с прежнего смещения и повторная отправка проходят мимо него. ' +
          'Защита от повтора живёт в схеме базы, поэтому приёмник может писать, падать и читать заново',
      );
    } finally {
      await db.close();
    }
  },
};
