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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { KAFKA_HEADERS, TOPICS } from '@fieldstream/contracts';
import type { RawBlock, TelemetryRaw } from '@fieldstream/contracts';
import {
  ROLES,
  bootstrapDatabase,
  connectionUrl,
  runMigrations,
  syncTopology,
} from '@fieldstream/db';
import type { ConnectionTarget } from '@fieldstream/db';
import {
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
import { createProducer, encodeMessage, headerText, sendMessages } from '@fieldstream/kafka';
import { createLogger } from '@fieldstream/nest-common';
import { AppModule } from '../../src/app.module.js';
import { loadEnv } from '../../src/config/env.js';
import { createMetrics } from '../../src/metrics/metrics.js';
import type { ProcessorMetrics } from '../../src/metrics/metrics.js';
import { RAW_GROUP } from '../../src/ingest/raw-consumer.service.js';

const DB_IMAGE = 'timescale/timescaledb-ha:pg16.6-ts2.17.2';
const KAFKA_IMAGE = 'apache/kafka:3.9.0';
const SUPERUSER = { user: 'postgres', password: 'superuser-pw' };
const PASSWORDS = { migrator: 'migrator-pw', ingest: 'ingest-pw', api: 'api-pw' };
const RAW = TOPICS.telemetryRaw.name;

const VALUES = new Map(buildSimulationValues(rc2000Profile, 5));
const REGISTERS = encodeSimulationRegisters(rc2000Profile, VALUES);
const BLOCKS: RawBlock[] = buildDeviceReadPlan(rc2000Profile).blocks.map((block) => ({
  registerType: block.registerType,
  startAddress: block.startAddress,
  words: readSimulatedBlock(REGISTERS, block),
}));
const ROWS_PER_FRAME = decodeFrame(rc2000Profile, BLOCKS).length;

interface Running {
  readonly app: NestFastifyApplication;
  readonly pool: pg.Pool;
  readonly metrics: ProcessorMetrics;
}

let db: StartedPostgreSqlContainer;
let broker: StartedTestContainer;
let target: ConnectionTarget;
let brokers: string;
let admin: pg.Client;
let kafka: Kafka;
let kafkaAdmin: Admin;
let producer: Producer;
let cursorMs = Math.floor(SystemClock.now() / 60_000) * 60_000 - 3_600_000;
const live = new Set<Running>();

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

/** Кадр прибора с моментом опроса atMs. */
const frameOf = (deviceCode: string, atMs: number): TelemetryRaw => ({
  schema: 'telemetry.raw',
  v: 1,
  ts: new Date(atMs).toISOString(),
  siteCode: 'SITE-A',
  gatewayCode: 'GW-01',
  lineCode: 'L1',
  deviceCode,
  slaveId: 1,
  profileKey: rc2000Profile.profileKey,
  profileVersion: rc2000Profile.version,
  blocks: BLOCKS,
  cycleMs: 40,
  traceId: atMs.toString(16).padStart(16, '0'),
});

/** Серия кадров прибора с шагом опроса 10 секунд, без пересечений между тестами. */
const series = (deviceCode: string, count: number): TelemetryRaw[] =>
  Array.from({ length: count }, () => {
    cursorMs += 10_000;
    return frameOf(deviceCode, cursorMs);
  });

/** Публикация кадров от имени сборщика, как в живом стенде. */
const publish = async (frames: readonly TelemetryRaw[]): Promise<void> => {
  await sendMessages(
    producer,
    frames.map((frame) =>
      encodeMessage(TOPICS.telemetryRaw, frame, {
        producer: TOPICS.telemetryRaw.owner,
        traceId: frame.traceId,
      }),
    ),
  );
};

const readingsOf = async (deviceCode: string): Promise<number> => {
  const result = await admin.query<{ n: string }>(
    `SELECT count(*) AS n FROM ts.readings r JOIN core.devices d ON d.id = r.device_id
     WHERE d.code = $1`,
    [deviceCode],
  );
  return Number(result.rows[0]?.n ?? 0);
};

/** Группа процессора подтвердила всё, что лежит в сыром топике. */
const caughtUp = async (): Promise<boolean> => {
  const [ends, committed] = await Promise.all([
    kafkaAdmin.fetchTopicOffsets(RAW),
    kafkaAdmin.fetchOffsets({ groupId: RAW_GROUP, topics: [RAW] }),
  ]);
  const byPartition = new Map(
    (committed[0]?.partitions ?? []).map((item) => [item.partition, item.offset]),
  );
  return ends.every((end) => end.high === '0' || byPartition.get(end.partition) === end.high);
};

/** Значение счётчика процессора по совпадающим меткам. */
const counter = async (
  metrics: ProcessorMetrics,
  name: string,
  labels: Readonly<Record<string, string>>,
): Promise<number> => {
  const metric = metrics.registry.getSingleMetric(name);
  if (metric === undefined) return 0;
  const { values } = await metric.get();
  return values
    .filter((item) => Object.entries(labels).every(([key, value]) => item.labels[key] === value))
    .reduce((sum, item) => sum + item.value, 0);
};

/** Процессор целиком, как в точке входа, но без HTTP-порта. */
const startProcessor = async (): Promise<Running> => {
  const env = loadEnv({
    KAFKA_BROKERS: brokers,
    DATABASE_HOST: target.host,
    DATABASE_PORT: String(target.port),
    POSTGRES_DB: target.database,
    FS_INGEST_PASSWORD: PASSWORDS.ingest,
    HEALTH_INTERVAL_MS: '1000',
    LOG_LEVEL: 'error',
  });
  const pool = new pg.Pool({
    connectionString: connectionUrl(target, ROLES.ingest, PASSWORDS.ingest),
    max: 6,
  });
  pool.on('error', () => undefined);
  const metrics = createMetrics();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      env,
      log: createLogger('stream-processor', env.LOG_LEVEL),
      clock: SystemClock,
      metrics,
      pool,
    }),
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
  const running = { app, pool, metrics };
  live.add(running);
  return running;
};

const stopProcessor = async (running: Running): Promise<void> => {
  live.delete(running);
  await running.app.close();
  await running.pool.end();
};

/** Сообщения очереди недоставленных с начала топика. */
const readDlq = async (count: number): Promise<KafkaMessage[]> => {
  const seen: KafkaMessage[] = [];
  const consumer = kafka.consumer({ groupId: `dlq-reader-${String(SystemClock.now())}` });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPICS.telemetryRawDlq.name, fromBeginning: true });
  await consumer.run({
    eachMessage: ({ message }) => {
      seen.push(message);
      return Promise.resolve();
    },
  });
  try {
    await waitFor(`${String(count)} сообщения в очереди недоставленных`, () =>
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
  await owner.end();

  kafka = new Kafka({ clientId: 'pipeline-test', brokers: [brokers], logLevel: logLevel.NOTHING });
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

afterEach(async () => {
  await Promise.all([...live].map(stopProcessor));
});

afterAll(async () => {
  await producer.disconnect();
  await kafkaAdmin.disconnect();
  await admin.end();
  await Promise.all([broker.stop(), db.stop()]);
});

describe('процессор на настоящих Kafka и TimescaleDB', () => {
  it('кадры ложатся в базу, а повтор после сброса смещений не добавляет ни строки', async () => {
    await publish(series('RC-101', 30));

    const first = await startProcessor();
    await waitFor(
      'кадры записаны',
      async () => (await readingsOf('RC-101')) === 30 * ROWS_PER_FRAME,
    );
    await waitFor('смещения подтверждены', caughtUp);
    await stopProcessor(first);

    await kafkaAdmin.resetOffsets({ groupId: RAW_GROUP, topic: RAW, earliest: true });
    expect(await caughtUp()).toBe(false);

    const second = await startProcessor();
    await waitFor('повтор дочитан', caughtUp);
    const replayed = await counter(second.metrics, 'fieldstream_processor_frames_total', {
      outcome: 'accepted',
    });
    const written = await counter(second.metrics, 'fieldstream_processor_rows_written_total', {
      table: 'readings',
    });
    await stopProcessor(second);

    expect(replayed).toBe(30);
    expect(written).toBe(0);
    expect(await readingsOf('RC-101')).toBe(30 * ROWS_PER_FRAME);
  });

  it('ядовитые сообщения уходят в очередь недоставленных сырыми байтами, партиция не встаёт', async () => {
    const running = await startProcessor();
    const broken = Buffer.from('{не json');
    await producer.send({
      topic: RAW,
      messages: [{ key: 'RC-102', value: broken, headers: { [KAFKA_HEADERS.traceId]: 'poison' } }],
    });
    await publish(series('RC-999', 1));
    await publish(series('RC-102', 5));

    await waitFor(
      'кадры после яда записаны',
      async () => (await readingsOf('RC-102')) === 5 * ROWS_PER_FRAME,
    );
    const dlq = await readDlq(2);
    const rows = await admin.query<{ error_class: string; key: string }>(
      `SELECT error->>'class' AS error_class, key FROM core.dlq_message ORDER BY 1`,
    );
    await stopProcessor(running);

    const byClass = new Map(
      dlq.map((message) => [headerText(message.headers, KAFKA_HEADERS.dlqErrorClass), message]),
    );
    const invalid = byClass.get('invalid_json');
    expect(invalid?.key?.toString()).toBe('RC-102');
    expect(invalid?.value?.equals(broken)).toBe(true);
    expect(headerText(invalid?.headers, KAFKA_HEADERS.dlqOriginTopic)).toBe(RAW);
    expect(headerText(invalid?.headers, KAFKA_HEADERS.dlqConsumerGroup)).toBe(RAW_GROUP);
    expect(headerText(invalid?.headers, KAFKA_HEADERS.traceId)).toBe('poison');
    expect(byClass.get('unknown_device')?.key?.toString()).toBe('RC-999');
    expect(rows.rows).toEqual([
      { error_class: 'invalid_json', key: 'RC-102' },
      { error_class: 'unknown_device', key: 'RC-999' },
    ]);
  });

  it('кратковременный отказ базы ставит партицию на паузу, после него всё дописывается без потерь', async () => {
    const running = await startProcessor();
    await publish(series('RC-104', 3));
    await waitFor(
      'процессор пишет',
      async () => (await readingsOf('RC-104')) === 3 * ROWS_PER_FRAME,
    );

    await admin.query(`ALTER ROLE ${ROLES.ingest} NOLOGIN`);
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1', [
      ROLES.ingest,
    ]);
    await publish(series('RC-104', 10));
    await waitFor(
      'сбой замечен',
      async () =>
        (await counter(running.metrics, 'fieldstream_processor_transient_errors_total', {
          topic: RAW,
        })) > 0,
    );
    await admin.query(`ALTER ROLE ${ROLES.ingest} LOGIN`);

    await waitFor('всё дописано', async () => (await readingsOf('RC-104')) === 13 * ROWS_PER_FRAME);
    await waitFor('смещения подтверждены', caughtUp);
    await stopProcessor(running);
  });
});
