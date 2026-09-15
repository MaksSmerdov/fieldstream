import 'reflect-metadata';
import net from 'node:net';
import pg from 'pg';
import { Kafka, logLevel } from 'kafkajs';
import type { Admin, Producer } from 'kafkajs';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { REPLAY_GROUP_PREFIX, TOPICS, replayGroupIdOf } from '@fieldstream/contracts';
import type { RawBlock, ReplayPatch, ReplayRun, TelemetryRaw } from '@fieldstream/contracts';
import {
  ROLES,
  bootstrapDatabase,
  connectionUrl,
  createReplayRun,
  loadAlarmRules,
  loadReplayRun,
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
  encodeSimulationRegisters,
  rc2000Profile,
  readSimulatedBlock,
} from '@fieldstream/device-profiles';
import { SystemClock } from '@fieldstream/domain';
import { createProducer, encodeMessage } from '@fieldstream/kafka';
import type { DecodedValue } from '@fieldstream/modbus-codec';
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
const CYCLE_MS = 10_000;

/** Начало окна перепрогона: полчаса назад, ровно на минуте, заведомо в сроке хранения. */
const WINDOW_FROM_MS = Math.floor(SystemClock.now() / 60_000) * 60_000 - 30 * 60_000;
const WINDOW_TO_MS = WINDOW_FROM_MS + 120_000;
const atCycle = (cycle: number): number => WINDOW_FROM_MS + cycle * CYCLE_MS;

/** Правка из демо: граница испарителя в оттайке +8 вместо +12. */
const PATCH: ReplayPatch = { metricKey: 'evap_temp_c', mode: 'defrost', maxValue: 8 };

interface Running {
  readonly app: NestFastifyApplication;
  readonly pool: pg.Pool;
}

/** Кадр в брокере: время кадра и время сообщения, по которому брокер ищет смещения. */
interface Timed {
  readonly frame: TelemetryRaw;
  readonly timestampMs: number;
}

let db: StartedPostgreSqlContainer;
let broker: StartedTestContainer;
let target: ConnectionTarget;
let brokers: string;
let admin: pg.Client;
let kafkaAdmin: Admin;
let producer: Producer;
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

/** Блоки кадра оттайки с заданной температурой испарителя, остальные значения спокойные. */
const defrostBlocks = (evap: number): RawBlock[] => {
  const values = new Map<string, DecodedValue>([
    ...buildSimulationValues(rc2000Profile, 36),
    ['defrost_state', 'heating'],
    ['evap_temp_c', evap],
  ]);
  const registers = encodeSimulationRegisters(rc2000Profile, values);
  return buildDeviceReadPlan(rc2000Profile).blocks.map((block) => ({
    registerType: block.registerType,
    startAddress: block.startAddress,
    words: readSimulatedBlock(registers, block),
  }));
};

const frameOf = (deviceCode: string, atMs: number, evap: number): TelemetryRaw => ({
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
  blocks: defrostBlocks(evap),
  cycleMs: 40,
  traceId: `${deviceCode}-${atMs.toString(16)}`,
});

/** Кадры прибора по циклам окна, время сообщения совпадает с временем кадра, как у сборщика. */
const cycles = (deviceCode: string, first: number, values: readonly number[]): Timed[] =>
  values.map((evap, index) => {
    const atMs = atCycle(first + index);
    return { frame: frameOf(deviceCode, atMs, evap), timestampMs: atMs };
  });

/** Публикация от имени сборщика с явным временем сообщения, по порядку времени. */
const publish = async (items: readonly Timed[]): Promise<void> => {
  const ordered = [...items].sort((left, right) => left.timestampMs - right.timestampMs);
  await producer.send({
    topic: RAW,
    messages: ordered.map(({ frame, timestampMs }) => {
      const message = encodeMessage(TOPICS.telemetryRaw, frame, {
        producer: TOPICS.telemetryRaw.owner,
        traceId: frame.traceId,
      });
      return {
        key: message.key,
        value: message.value,
        headers: { ...message.headers },
        timestamp: String(timestampMs),
      };
    }),
  });
};

/** Смещения боевой группы процессора по партициям сырого топика. */
const ingestOffsets = async (): Promise<Record<string, string>> => {
  const [topic] = await kafkaAdmin.fetchOffsets({ groupId: INGEST_GROUP, topics: [RAW] });
  return Object.fromEntries(
    (topic?.partitions ?? []).map((item) => [String(item.partition), item.offset]),
  );
};

/** Боевая группа подтвердила всё, что лежит в сыром топике. Пока координатор не готов, ещё нет. */
const caughtUp = async (): Promise<boolean> => {
  try {
    const [ends, committed] = await Promise.all([
      kafkaAdmin.fetchTopicOffsets(RAW),
      ingestOffsets(),
    ]);
    return ends.every((end) => end.high === '0' || committed[String(end.partition)] === end.high);
  } catch {
    return false;
  }
};

const replayGroups = async (): Promise<string[]> =>
  (await kafkaAdmin.listGroups()).groups
    .map((group) => group.groupId)
    .filter((groupId) => groupId.startsWith(REPLAY_GROUP_PREFIX));

/** Процессор целиком, как в точке входа, но без HTTP-порта и с частым тактом перепрогона. */
const startProcessor = async (): Promise<Running> => {
  const env = loadEnv({
    KAFKA_BROKERS: brokers,
    DATABASE_HOST: target.host,
    DATABASE_PORT: String(target.port),
    POSTGRES_DB: target.database,
    FS_INGEST_PASSWORD: PASSWORDS.ingest,
    HEALTH_INTERVAL_MS: '1000',
    REPLAY_POLL_MS: '250',
    REPLAY_HEARTBEAT_MS: '250',
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
      instanceId: 'replay',
    }),
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
  const running = { app, pool };
  live.add(running);
  return running;
};

const stopProcessor = async (running: Running): Promise<void> => {
  live.delete(running);
  await running.app.close();
  await running.pool.end();
};

/** Прогон с демо-правкой по снимку уставок из базы, как его ставит шлюз. */
const requestRun = async (fromMs: number, toMs: number): Promise<ReplayRun> => {
  const rulesBaseline = await loadAlarmRules(admin, { deviceCodes: ['RC-101'] });
  const rulesPatched = rulesBaseline.map((rule) =>
    rule.metricKey === PATCH.metricKey && rule.mode === PATCH.mode
      ? { ...rule, maxValue: 8 }
      : rule,
  );
  const run = await createReplayRun(admin, {
    requestedBy: 'engineer@fieldstream.local',
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    deviceCodes: ['RC-101'],
    patches: [PATCH],
    rulesBaseline,
    rulesPatched,
  });
  if (run === null) throw new Error('стенд занят другим прогоном');
  return run;
};

const finishedRun = async (id: string): Promise<ReplayRun> => {
  await waitFor('прогон завершён', async () => {
    const status = (await loadReplayRun(admin, id))?.status;
    return status === 'done' || status === 'failed';
  });
  const run = await loadReplayRun(admin, id);
  if (run === null) throw new Error('прогон пропал');
  return run;
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

  const kafka = new Kafka({
    clientId: 'replay-test',
    brokers: [brokers],
    logLevel: logLevel.NOTHING,
  });
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

describe('перепрогон уставок на настоящих Kafka и TimescaleDB', () => {
  /**
   * Змеевик в оттайке греется до +10. Граница +12 молчит, граница +8 срабатывает после выдержки
   * и снимается, когда испаритель остывает. Кадры до окна и после него дали бы ещё эпизоды,
   * если бы попали в расчёт. Кадры сразу после окна читаются из-за запаса на задержку отправки,
   * а их и кадры с временем сообщения внутри окна, но временем кадра вне его, отсекает фильтр
   * по времени кадра.
   */
  it('правка +12 -> +8 даёт срабатывание только в варианте «стало», итог и чистка на месте', async () => {
    await publish([
      ...cycles('RC-101', -20, [10, 10, 10, 10, 10, 10, 10, 10]),
      { frame: frameOf('RC-101', WINDOW_FROM_MS - 5_000, 10), timestampMs: WINDOW_FROM_MS },
      ...cycles('RC-101', 1, [10, 10, 10, 10, 10, 10, 10, 10, 6, 6]),
      ...cycles('RC-102', 1, [10, 10, 10, 10, 10, 10, 10, 10]),
      { frame: frameOf('RC-101', WINDOW_TO_MS + 5_000, 10), timestampMs: atCycle(11) },
      ...cycles('RC-101', 13, [10, 10, 10, 10, 10, 10, 10, 10]),
    ]);

    await admin.query(
      `INSERT INTO core.replay_run (requested_by, from_ts, to_ts, device_codes, patches,
         rules_baseline, rules_patched, status, created_at, finished_at)
       SELECT 'old', $1, $2, ARRAY['RC-101'], '[]', '[]', '[]', 'done',
              now() - make_interval(hours => g), now() - make_interval(hours => g)
       FROM generate_series(1, 20) AS g`,
      [new Date(WINDOW_FROM_MS).toISOString(), new Date(WINDOW_TO_MS).toISOString()],
    );
    await admin.query(
      `INSERT INTO core.replay_alarm_episode (run_id, variant, device_id, metric_key, mode,
         severity, boundary, value, threshold, raised_at)
       SELECT r.id, 'patched', d.id, 'evap_temp_c', 'defrost', 'info', 'max', 10, 8, r.from_ts
       FROM core.replay_run r CROSS JOIN core.devices d
       WHERE r.requested_by = 'old' AND d.code = 'RC-101'`,
    );

    const running = await startProcessor();
    await waitFor('боевая группа дочитала сырой топик', caughtUp);
    const ingestBefore = await ingestOffsets();

    const requested = await requestRun(WINDOW_FROM_MS, WINDOW_TO_MS);
    const run = await finishedRun(requested.id);
    await waitFor('временная группа удалена', async () => (await replayGroups()).length === 0);
    const ingestAfter = await ingestOffsets();
    await stopProcessor(running);

    expect(run.error).toBeNull();
    expect(run).toMatchObject({
      status: 'done',
      groupId: replayGroupIdOf(run.id),
      coveredFrom: new Date(atCycle(1)).toISOString(),
      coveredTo: new Date(atCycle(10)).toISOString(),
      progress: { offsetsTotal: 28, offsetsDone: 28, framesMatched: 10, framesRejected: 0 },
    });

    const episodes = await admin.query<{
      variant: string;
      metric_key: string;
      mode: string;
      threshold: number;
      raised_at: Date;
      cleared_at: Date | null;
      cleared_value: number | null;
    }>(
      `SELECT variant, metric_key, mode, threshold, raised_at, cleared_at, cleared_value
       FROM core.replay_alarm_episode WHERE run_id = $1 ORDER BY variant, raised_at`,
      [run.id],
    );
    expect(episodes.rows.filter((row) => row.variant === 'baseline')).toEqual([]);
    expect(episodes.rows).toEqual([
      {
        variant: 'patched',
        metric_key: 'evap_temp_c',
        mode: 'defrost',
        threshold: 8,
        raised_at: new Date(atCycle(6)),
        cleared_at: new Date(atCycle(9)),
        cleared_value: 6,
      },
    ]);

    const kept = await admin.query<{ requested_by: string; n: string }>(
      `SELECT requested_by, count(*) AS n FROM core.replay_run GROUP BY requested_by ORDER BY 1`,
    );
    expect(kept.rows).toEqual([
      { requested_by: 'engineer@fieldstream.local', n: '1' },
      { requested_by: 'old', n: '19' },
    ]);
    const orphans = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.replay_alarm_episode e
       JOIN core.replay_run r ON r.id = e.run_id WHERE r.requested_by = 'old'`,
    );
    expect(orphans.rows[0]?.n).toBe('19');

    expect(ingestAfter).toEqual(ingestBefore);
    expect(await replayGroups()).toEqual([]);
  });

  it('окно без кадров сразу завершается без временной группы', async () => {
    const running = await startProcessor();

    const requested = await requestRun(WINDOW_FROM_MS - 3 * 3_600_000, WINDOW_FROM_MS - 7_200_000);
    const run = await finishedRun(requested.id);
    await stopProcessor(running);

    expect(run).toMatchObject({
      status: 'done',
      error: null,
      groupId: null,
      coveredFrom: null,
      coveredTo: null,
      progress: { offsetsTotal: 0, offsetsDone: 0, framesMatched: 0, framesRejected: 0 },
    });
    expect(await replayGroups()).toEqual([]);
  });
});
