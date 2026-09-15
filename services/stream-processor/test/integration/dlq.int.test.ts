import 'reflect-metadata';
import net from 'node:net';
import pg from 'pg';
import { Kafka, logLevel } from 'kafkajs';
import type { Admin, KafkaMessage, Producer } from 'kafkajs';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KAFKA_HEADERS, TOPICS } from '@fieldstream/contracts';
import type { DlqRedrive, RawBlock, TelemetryRaw } from '@fieldstream/contracts';
import {
  ROLES,
  bootstrapDatabase,
  connectionUrl,
  enqueueDlqRedrive,
  loadDlqCounts,
  loadDlqRedrive,
  runMigrations,
  syncAlarmRules,
  syncTopology,
} from '@fieldstream/db';
import type { ConnectionTarget } from '@fieldstream/db';
import {
  DEFAULT_ALARM_RULES,
  DEMO_STAND,
  DEVICE_PROFILES,
  buildDeviceReadPlan,
  buildSimulationValues,
  decodeFrame,
  encodeSimulationRegisters,
  rc2000Profile,
  readSimulatedBlock,
} from '@fieldstream/device-profiles';
import { SystemClock } from '@fieldstream/domain';
import { createProducer, encodeMessage, headerText } from '@fieldstream/kafka';
import { createLogger } from '@fieldstream/nest-common';
import { AppModule } from '../../src/app.module.js';
import { loadEnv } from '../../src/config/env.js';
import { INGEST_GROUP } from '../../src/ingest/assignment.js';
import { createMetrics } from '../../src/metrics/metrics.js';

const DB_IMAGE = 'timescale/timescaledb-ha:pg16.6-ts2.17.2';
/** Планировщик TimescaleDB выключен: политики просыпаются посреди теста, а агрегаты тесты обновляют сами. */
const NO_BACKGROUND_JOBS = ['postgres', '-c', 'timescaledb.max_background_workers=0'];
const KAFKA_IMAGE = 'apache/kafka:3.9.0';
const SUPERUSER = { user: 'postgres', password: 'superuser-pw' };
const PASSWORDS = { migrator: 'migrator-pw', ingest: 'ingest-pw', api: 'api-pw' };
const RAW = TOPICS.telemetryRaw.name;
const DLQ = TOPICS.telemetryRawDlq.name;
const READINGS = TOPICS.telemetryReadings.name;

/** Кадр без нарушений уставок: значения подобраны так, что ни одна граница не задета. */
const REGISTERS = encodeSimulationRegisters(
  rc2000Profile,
  new Map(buildSimulationValues(rc2000Profile, 36)),
);
const BLOCKS: RawBlock[] = buildDeviceReadPlan(rc2000Profile).blocks.map((block) => ({
  registerType: block.registerType,
  startAddress: block.startAddress,
  words: readSimulatedBlock(REGISTERS, block),
}));
const ROWS_PER_FRAME = decodeFrame(rc2000Profile, BLOCKS).length;

interface Running {
  readonly app: NestFastifyApplication;
  readonly pool: pg.Pool;
}

interface Seen {
  readonly partition: number;
  readonly message: KafkaMessage;
}

interface DlqRowView {
  readonly id: string;
  readonly partition: number;
  readonly attempts: number;
  readonly first_seen: Date;
  readonly resolved_at: Date | null;
  readonly final_rejected: boolean;
}

let db: StartedPostgreSqlContainer;
let broker: StartedTestContainer;
let target: ConnectionTarget;
let brokers: string;
let admin: pg.Client;
let kafka: Kafka;
let kafkaAdmin: Admin;
let producer: Producer;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Свободный порт хоста: брокер объявляет клиентам именно его. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });

/** Ждёт условие с опросом, без фиксированных пауз «на всякий случай». */
const waitFor = async (what: string, check: () => Promise<boolean>): Promise<void> => {
  const deadline = SystemClock.now() + 45_000;
  while (SystemClock.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`не дождались: ${what}`);
};

/** Процессор целиком, как в точке входа, но без HTTP-порта и с частым опросом запросов подачи. */
const startProcessor = async (): Promise<Running> => {
  const env = loadEnv({
    KAFKA_BROKERS: brokers,
    DATABASE_HOST: target.host,
    DATABASE_PORT: String(target.port),
    POSTGRES_DB: target.database,
    FS_INGEST_PASSWORD: PASSWORDS.ingest,
    HEALTH_INTERVAL_MS: '1000',
    DLQ_REDRIVE: 'on',
    DLQ_REDRIVE_POLL_MS: '200',
    LOG_LEVEL: process.env['PROCESSOR_LOG'] ?? 'error',
  });
  const pool = new pg.Pool({
    connectionString: connectionUrl(target, ROLES.ingest, PASSWORDS.ingest),
    max: 6,
  });
  pool.on('error', () => undefined);
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      env,
      log: createLogger('stream-processor', env.LOG_LEVEL),
      clock: SystemClock,
      metrics: createMetrics(),
      pool,
      instanceId: 'dlq',
    }),
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
  return { app, pool };
};

const stopProcessor = async (running: Running): Promise<void> => {
  await running.app.close();
  await running.pool.end();
};

/** Строки очереди недоставленных по порядку появления. */
const dlqRows = async (): Promise<DlqRowView[]> =>
  (
    await admin.query<DlqRowView>(
      `SELECT id, partition, attempts, first_seen, resolved_at, final_rejected
       FROM core.dlq_message ORDER BY id`,
    )
  ).rows;

/** Запрос повторной подачи от имени интерфейса и ожидание его завершения процессором. */
const redrive = async (maxMessages: number): Promise<DlqRedrive | null> => {
  const request = await enqueueDlqRedrive(admin, {
    requestedBy: 'engineer@fieldstream.local',
    maxMessages,
  });
  await waitFor(`запрос ${request.id} завершён`, async () => {
    const status = (await loadDlqRedrive(admin, request.id))?.status;
    return status === 'done' || status === 'failed';
  });
  return loadDlqRedrive(admin, request.id);
};

/** Годный кадр прибора с моментом опроса atMs. */
const frameOf = (deviceCode: string, lineCode: string, atMs: number): TelemetryRaw => ({
  schema: 'telemetry.raw',
  v: 1,
  ts: new Date(atMs).toISOString(),
  siteCode: 'SITE-A',
  gatewayCode: 'GW-01',
  lineCode,
  deviceCode,
  slaveId: 1,
  profileKey: rc2000Profile.profileKey,
  profileVersion: rc2000Profile.version,
  blocks: BLOCKS,
  cycleMs: 40,
  traceId: atMs.toString(16).padStart(16, '0'),
});

/** Сырое сообщение кадра с дополнительными заголовками. */
const rawOf = (frame: TelemetryRaw, headers: Record<string, string>) => {
  const message = encodeMessage(TOPICS.telemetryRaw, frame, {
    producer: TOPICS.telemetryRaw.owner,
    traceId: frame.traceId,
  });
  return { key: message.key, value: message.value, headers: { ...message.headers, ...headers } };
};

const readingsOf = async (deviceCode: string): Promise<number> => {
  const result = await admin.query<{ n: string }>(
    `SELECT count(*) AS n FROM ts.readings r JOIN core.devices d ON d.id = r.device_id
     WHERE d.code = $1`,
    [deviceCode],
  );
  return Number(result.rows[0]?.n ?? 0);
};

/** Процессор подтвердил всё, что лежит в сыром топике: пачки записаны и опубликованы. */
const rawSettled = async (): Promise<boolean> => {
  const [ends, committed] = await Promise.all([
    kafkaAdmin.fetchTopicOffsets(RAW),
    kafkaAdmin.fetchOffsets({ groupId: INGEST_GROUP, topics: [RAW] }),
  ]);
  const done = new Map(
    (committed[0]?.partitions ?? []).map((item) => [item.partition, item.offset]),
  );
  return ends.every((end) => end.high === '0' || done.get(end.partition) === end.high);
};

/** Сколько сообщений всего лежит в топике. */
const totalIn = async (topic: string): Promise<number> =>
  (await kafkaAdmin.fetchTopicOffsets(topic)).reduce((sum, item) => sum + Number(item.high), 0);

/** Конец лога партиции. */
const endOf = async (topic: string, partition: number): Promise<string | undefined> =>
  (await kafkaAdmin.fetchTopicOffsets(topic)).find((item) => item.partition === partition)?.high;

/** Сообщения топика с начала вместе с партицией. */
const readTopic = async (topic: string, count: number): Promise<Seen[]> => {
  const seen: Seen[] = [];
  const consumer = kafka.consumer({ groupId: `dlq-test-reader-${String(SystemClock.now())}` });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  await consumer.run({
    eachMessage: ({ partition, message }) => {
      seen.push({ partition, message });
      return Promise.resolve();
    },
  });
  try {
    await waitFor(`${String(count)} сообщения в ${topic}`, () =>
      Promise.resolve(seen.length >= count),
    );
  } finally {
    await consumer.disconnect();
  }
  return seen;
};

beforeAll(async () => {
  const hostPort = await freePort();
  const [startedDb, startedBroker] = await Promise.all([
    new PostgreSqlContainer(DB_IMAGE)
      .withDatabase('fieldstream')
      .withUsername(SUPERUSER.user)
      .withPassword(SUPERUSER.password)
      .withCommand(NO_BACKGROUND_JOBS)
      .start(),
    new GenericContainer(KAFKA_IMAGE)
      .withExposedPorts({ container: 29092, host: hostPort })
      .withEnvironment({
        KAFKA_NODE_ID: '1',
        KAFKA_PROCESS_ROLES: 'broker,controller',
        KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093,PLAINTEXT_HOST://:29092',
        KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://localhost:9092,PLAINTEXT_HOST://localhost:${String(hostPort)}`,
        KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
          'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,PLAINTEXT_HOST:PLAINTEXT',
        KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
        KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
        KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
        KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
        KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
        KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
        KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
        KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
        KAFKA_HEAP_OPTS: '-Xmx512m -Xms512m',
      })
      .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
      .start(),
  ]);
  db = startedDb;
  broker = startedBroker;
  target = { host: db.getHost(), port: db.getPort(), database: 'fieldstream' };
  brokers = `localhost:${String(hostPort)}`;

  admin = new pg.Client({
    connectionString: connectionUrl(target, SUPERUSER.user, SUPERUSER.password),
  });
  await admin.connect();
  await bootstrapDatabase(admin, 'fieldstream', PASSWORDS);
  const migratorUrl = connectionUrl(target, ROLES.migrator, PASSWORDS.migrator);
  await runMigrations({ databaseUrl: migratorUrl, direction: 'up' });
  const owner = new pg.Client({ connectionString: migratorUrl });
  await owner.connect();
  await syncTopology(owner, DEMO_STAND, DEVICE_PROFILES);
  await syncAlarmRules(owner, DEFAULT_ALARM_RULES);
  await owner.end();

  kafka = new Kafka({ clientId: 'dlq-test', brokers: [brokers], logLevel: logLevel.NOTHING });
  kafkaAdmin = kafka.admin();
  await kafkaAdmin.connect();
  await kafkaAdmin.createTopics({
    waitForLeaders: true,
    topics: Object.values(TOPICS).map((spec) => ({
      topic: spec.name,
      numPartitions: spec.partitions,
      replicationFactor: 1,
      configEntries: Object.entries({
        'cleanup.policy': spec.cleanupPolicy,
        ...(spec.retentionMs === null ? {} : { 'retention.ms': String(spec.retentionMs) }),
        ...spec.configs,
      }).map(([name, value]) => ({ name, value })),
    })),
  });
  producer = createProducer(kafka);
  await producer.connect();
});

afterAll(async () => {
  await producer.disconnect();
  await kafkaAdmin.disconnect();
  await admin.end();
  await Promise.all([broker.stop(), db.stop()]);
});

describe('повторная подача из очереди недоставленных', () => {
  /**
   * Кадр, который не разбирается, проходит весь круг три раза: каждая подача возвращает его
   * в ту же партицию сырого топика, каждая неудача продолжает счёт попыток, а после третьей
   * он больше не подаётся и не висит в счёте ждущих разбора.
   */
  it('ядовитый кадр возвращается в свою партицию, счёт попыток растёт, третья неудача окончательна', async () => {
    const running = await startProcessor();
    const poison = Buffer.from('{не json');
    await producer.send({
      topic: RAW,
      messages: [{ key: 'RC-102', value: poison, headers: { [KAFKA_HEADERS.traceId]: 'poison' } }],
    });

    await waitFor('первая неудача записана', async () => (await dlqRows()).length === 1);
    const origin = (await dlqRows())[0];
    expect(origin?.attempts).toBe(1);
    const partition = origin?.partition ?? -1;

    expect(await redrive(10)).toMatchObject({ status: 'done', redriven: 1, rejected: 0 });
    await waitFor('вторая неудача записана', async () => (await dlqRows()).length === 2);
    expect((await dlqRows())[1]?.attempts).toBe(2);

    expect(await redrive(10)).toMatchObject({ status: 'done', redriven: 1, rejected: 0 });
    await waitFor('третья неудача записана', async () => (await dlqRows()).length === 3);

    const rawEnd = await endOf(RAW, partition);
    expect(await redrive(10)).toMatchObject({
      status: 'done',
      redriven: 0,
      rejected: 1,
      error: null,
    });
    expect(await endOf(RAW, partition)).toBe(rawEnd);
    expect(await redrive(10)).toMatchObject({ status: 'done', redriven: 0, rejected: 0 });

    const raw = await readTopic(RAW, 3);
    const dlq = await readTopic(DLQ, 3);
    const rows = await dlqRows();
    expect(await loadDlqCounts(admin)).toEqual({ unresolved: 0, total: 3 });
    await stopProcessor(running);

    expect(raw.map((item) => item.message.key?.toString())).toEqual(['RC-102', 'RC-102', 'RC-102']);
    expect(raw.map((item) => item.partition)).toEqual([partition, partition, partition]);
    expect(raw.every((item) => item.message.value?.equals(poison))).toBe(true);
    expect(raw.map((item) => headerText(item.message.headers, KAFKA_HEADERS.dlqAttempt))).toEqual([
      null,
      '1',
      '2',
    ]);
    expect(raw.map((item) => headerText(item.message.headers, KAFKA_HEADERS.traceId))).toEqual([
      'poison',
      'poison',
      'poison',
    ]);
    expect(raw.map((item) => headerText(item.message.headers, KAFKA_HEADERS.dlqRedriveOf))).toEqual(
      [null, rows[0]?.id, rows[1]?.id],
    );

    const firstFailedAt = origin?.first_seen.toISOString();
    expect(dlq.map((item) => headerText(item.message.headers, KAFKA_HEADERS.dlqAttempt))).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(
      dlq.map((item) => headerText(item.message.headers, KAFKA_HEADERS.dlqFirstFailedAt)),
    ).toEqual([firstFailedAt, firstFailedAt, firstFailedAt]);

    expect(
      rows.map((row) => ({
        partition: row.partition,
        attempts: row.attempts,
        firstSeen: row.first_seen.toISOString(),
        resolved: row.resolved_at !== null,
        finalRejected: row.final_rejected,
      })),
    ).toEqual([
      { partition, attempts: 1, firstSeen: firstFailedAt, resolved: true, finalRejected: false },
      { partition, attempts: 2, firstSeen: firstFailedAt, resolved: true, finalRejected: false },
      { partition, attempts: 3, firstSeen: firstFailedAt, resolved: false, finalRejected: true },
    ]);
  }, 240_000);

  /**
   * Возвращённый годный кадр старше всего, что процессор видел: он только дописывает показания
   * и закрывает свою строку очереди, а в живой канал не идёт. Две копии одной строки, упавшие
   * снова (подача после сбоя между отправкой и коммитом), дают одну новую строку, а не две.
   */
  it('возвращённый кадр пишет только показания, копии одной строки не множат очередь', async () => {
    const running = await startProcessor();
    const nowMs = SystemClock.now();
    const failedAt = new Date(nowMs - 3_600_000).toISOString();
    const origins = await admin.query<{ id: string }>(
      `INSERT INTO core.dlq_message (source_topic, partition, "offset", key, error)
       VALUES ($1, 0, 900001, 'RC-104', '{"class":"unknown_device"}'),
              ($1, 0, 900002, 'RC-106', '{"class":"invalid_json"}')
       RETURNING id`,
      [RAW],
    );
    const [frameOrigin, poisonOrigin] = origins.rows.map((row) => row.id);
    const redriveOf = (id: string | undefined): Record<string, string> => ({
      [KAFKA_HEADERS.dlqAttempt]: '1',
      [KAFKA_HEADERS.dlqFirstFailedAt]: failedAt,
      [KAFKA_HEADERS.dlqRedriveOf]: id ?? '',
    });
    const poisonCopy = {
      key: 'RC-106',
      value: Buffer.from('{не json'),
      headers: redriveOf(poisonOrigin),
    };
    const readingsBefore = await totalIn(READINGS);

    await producer.send({
      topic: RAW,
      messages: [
        rawOf(frameOf('RC-104', 'L2', nowMs - 3_600_000), redriveOf(frameOrigin)),
        poisonCopy,
        poisonCopy,
      ],
    });
    await producer.send({ topic: RAW, messages: [rawOf(frameOf('RC-103', 'L1', nowMs), {})] });

    await waitFor(
      'показания обоих кадров записаны',
      async () =>
        (await readingsOf('RC-104')) === ROWS_PER_FRAME && (await readingsOf('RC-103')) > 0,
    );
    await waitFor('сырой топик подтверждён целиком', rawSettled);

    const copies = await admin.query<{ attempts: number; first_seen: Date }>(
      `SELECT attempts, first_seen FROM core.dlq_message WHERE redrive_of = $1`,
      [poisonOrigin],
    );
    const closed = await admin.query<{ id: string; resolved: boolean }>(
      `SELECT id, resolved_at IS NOT NULL AS resolved FROM core.dlq_message
       WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [[frameOrigin, poisonOrigin]],
    );
    const readingsAfter = await totalIn(READINGS);
    await stopProcessor(running);

    expect(await readingsOf('RC-103')).toBe(ROWS_PER_FRAME);
    expect(readingsAfter - readingsBefore).toBe(1);
    expect(closed.rows.map((row) => row.resolved)).toEqual([true, true]);
    expect(
      copies.rows.map((row) => ({
        attempts: row.attempts,
        firstSeen: row.first_seen.toISOString(),
      })),
    ).toEqual([{ attempts: 2, firstSeen: failedAt }]);
  }, 240_000);
});
