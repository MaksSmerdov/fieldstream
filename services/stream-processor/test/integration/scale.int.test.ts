import 'reflect-metadata';
import net from 'node:net';
import pg from 'pg';
import { AssignerProtocol, Kafka, logLevel } from 'kafkajs';
import type { Admin, Producer } from 'kafkajs';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TOPICS } from '@fieldstream/contracts';
import type { PollCycle, RawBlock, TelemetryRaw } from '@fieldstream/contracts';
import {
  ROLES,
  bootstrapDatabase,
  connectionUrl,
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
import { SystemClock, alarmDedupeKey, alarmIdOf } from '@fieldstream/domain';
import { createProducer, encodeMessage, partitionForKey } from '@fieldstream/kafka';
import type { OutgoingMessage } from '@fieldstream/kafka';
import { createLogger } from '@fieldstream/nest-common';
import { AppModule } from '../../src/app.module.js';
import { loadEnv } from '../../src/config/env.js';
import { INGEST_GROUP } from '../../src/ingest/assignment.js';
import { IngestConsumerService } from '../../src/ingest/ingest-consumer.service.js';
import type { Ownership } from '../../src/ingest/ingest-consumer.service.js';
import { createMetrics } from '../../src/metrics/metrics.js';
import { ProducerService } from '../../src/publish/producer.service.js';

const DB_IMAGE = 'timescale/timescaledb-ha:pg16.6-ts2.17.2';
/** Планировщик TimescaleDB выключен: политики просыпаются посреди теста, а агрегаты тесты обновляют сами. */
const NO_BACKGROUND_JOBS = ['postgres', '-c', 'timescaledb.max_background_workers=0'];
const KAFKA_IMAGE = 'apache/kafka:3.9.0';
const SUPERUSER = { user: 'postgres', password: 'superuser-pw' };
const PASSWORDS = { migrator: 'migrator-pw', ingest: 'ingest-pw', api: 'api-pw' };
const RAW = TOPICS.telemetryRaw.name;
const CYCLES = TOPICS.pollCycles.name;
const PARTITIONS = TOPICS.telemetryRaw.partitions;
const STAND_CODES = DEMO_STAND.devices.map((device) => device.code);
const LINE_OF = new Map(DEMO_STAND.devices.map((device) => [device.code, device.lineCode]));
const COOLERS = DEMO_STAND.devices
  .filter((device) => device.profileKey === rc2000Profile.profileKey)
  .map((device) => device.code);

/** Кадр без нарушений уставок: значения подобраны так, что ни одна граница не задета. */
const CALM_REGISTERS = encodeSimulationRegisters(
  rc2000Profile,
  new Map(buildSimulationValues(rc2000Profile, 36)),
);
const CALM_BLOCKS: RawBlock[] = buildDeviceReadPlan(rc2000Profile).blocks.map((block) => ({
  registerType: block.registerType,
  startAddress: block.startAddress,
  words: readSimulatedBlock(CALM_REGISTERS, block),
}));

/** Отправленное экземпляром состояние прибора и то, считал ли он прибор своим в момент отправки. */
interface StateSent {
  readonly deviceCode: string;
  readonly status: string;
  readonly owned: boolean;
}

interface Running {
  readonly instanceId: string;
  readonly app: NestFastifyApplication;
  readonly pool: pg.Pool;
  readonly ingest: IngestConsumerService;
  readonly states: StateSent[];
}

/** Что экземпляр считает своим и что брокер ему на самом деле назначил. */
interface Settled {
  readonly ownership: Ownership;
  readonly assignment: Readonly<Record<string, readonly number[]>>;
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
  lineCode: LINE_OF.get(deviceCode) ?? 'L1',
  deviceCode,
  slaveId: 1,
  profileKey: rc2000Profile.profileKey,
  profileVersion: rc2000Profile.version,
  blocks: CALM_BLOCKS,
  cycleMs: 40,
  traceId: atMs.toString(16).padStart(16, '0'),
});

/** Серия кадров прибора с шагом опроса 10 секунд, без пересечений между тестами. */
const series = (deviceCode: string, count: number): TelemetryRaw[] =>
  Array.from({ length: count }, () => {
    cursorMs += 10_000;
    return frameOf(deviceCode, cursorMs);
  });

/** Успешный цикл опроса прибора в текущий момент: иначе здоровье сочтёт успех протухшим. */
const okCycleOf = (deviceCode: string): PollCycle => ({
  schema: 'poll.cycle',
  v: 1,
  ts: new Date(SystemClock.now()).toISOString(),
  lineCode: LINE_OF.get(deviceCode) ?? 'L1',
  deviceCode,
  ok: true,
  errorKind: null,
  durationMs: 40,
  requestCount: 4,
  planMode: 'merged',
  traceId: SystemClock.now().toString(16).padStart(16, '0'),
});

/** Отправка одного сообщения от имени сборщика. Возвращает партицию, которую выбрал продюсер. */
const sendOne = async (message: OutgoingMessage): Promise<number | undefined> => {
  const [metadata] = await producer.send({
    topic: message.topic,
    messages: [{ key: message.key, value: message.value, headers: { ...message.headers } }],
  });
  return metadata?.partition;
};

const publishFrame = (frame: TelemetryRaw): Promise<number | undefined> =>
  sendOne(
    encodeMessage(TOPICS.telemetryRaw, frame, {
      producer: TOPICS.telemetryRaw.owner,
      traceId: frame.traceId,
    }),
  );

const publishCycle = (cycle: PollCycle): Promise<number | undefined> =>
  sendOne(
    encodeMessage(TOPICS.pollCycles, cycle, {
      producer: TOPICS.pollCycles.owner,
      traceId: cycle.traceId,
    }),
  );

/** Приборы, чьи ключи ведут в эти партиции по разделителю продюсера. */
const devicesOf = (partitions: readonly number[]): string[] =>
  STAND_CODES.filter((code) => partitions.includes(partitionForKey(code, PARTITIONS)));

const sortedNumbers = (values: readonly number[]): number[] =>
  [...values].sort((left, right) => left - right);

/**
 * Процессор целиком, как в точке входа, но без HTTP-порта и со своим именем экземпляра.
 * Каждое отправленное в топик состояние прибора запоминается вместе с тем, владел ли им экземпляр.
 */
const startProcessor = async (instanceId: string): Promise<Running> => {
  const env = loadEnv({
    KAFKA_BROKERS: brokers,
    DATABASE_HOST: target.host,
    DATABASE_PORT: String(target.port),
    POSTGRES_DB: target.database,
    FS_INGEST_PASSWORD: PASSWORDS.ingest,
    PROCESSOR_INSTANCE_ID: instanceId,
    HEALTH_INTERVAL_MS: '1000',
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
      instanceId,
    }),
    new FastifyAdapter(),
    { logger: false },
  );
  const ingest = app.get(IngestConsumerService);
  const states: StateSent[] = [];
  const producerService = app.get(ProducerService);
  const send = producerService.send.bind(producerService);
  vi.spyOn(producerService, 'send').mockImplementation((messages) => {
    const devices = ingest.ownership()?.devices;
    for (const message of messages) {
      if (message.topic !== TOPICS.deviceState.name) continue;
      const state = TOPICS.deviceState.schema.parse(JSON.parse(message.value));
      states.push({
        deviceCode: state.deviceCode,
        status: state.status,
        owned: devices?.has(state.deviceCode) === true,
      });
    }
    return send(messages);
  });
  await app.init();
  const running = { instanceId, app, pool, ingest, states };
  live.add(running);
  return running;
};

const stopProcessor = async (running: Running): Promise<void> => {
  live.delete(running);
  await running.app.close();
  await running.pool.end();
};

/**
 * Ждёт устоявшуюся группу: брокер видит ровно эти экземпляры, и каждый уже принял то назначение,
 * которое брокер ему выдал, включая восстановление состояния новых приборов.
 */
const settle = async (running: readonly Running[]): Promise<Settled[]> => {
  let settled: Settled[] = [];

  await waitFor(`группа из ${String(running.length)} экземпляров устоялась`, async () => {
    const group = (await kafkaAdmin.describeGroups([INGEST_GROUP])).groups[0];
    if (group?.state !== 'Stable' || group.members.length !== running.length) return false;

    const byClient = new Map(
      group.members.map((member) => [
        member.clientId,
        AssignerProtocol.MemberAssignment.decode(member.memberAssignment)?.assignment ?? {},
      ]),
    );
    const views = running.map((item) => ({
      ownership: item.ingest.ownership(),
      assignment: byClient.get(`stream-processor-${item.instanceId}`),
    }));

    if (
      !views.every(
        (view) =>
          view.ownership !== null &&
          view.assignment !== undefined &&
          sortedNumbers(view.assignment[RAW] ?? []).join() ===
            sortedNumbers(view.ownership.partitions).join(),
      )
    ) {
      return false;
    }

    settled = views.flatMap((view) =>
      view.ownership === null || view.assignment === undefined
        ? []
        : [{ ownership: view.ownership, assignment: view.assignment }],
    );
    return true;
  });

  return settled;
};

/** Приборы, чьё состояние экземпляр отправил, не считая их своими. */
const foreignStates = (running: Running): string[] =>
  running.states.filter((sent) => !sent.owned).map((sent) => sent.deviceCode);

/** Экземпляр сам отправил online каждого из этих приборов. */
const sentOnline = (running: Running, deviceCodes: readonly string[]): boolean =>
  deviceCodes.every((code) =>
    running.states.some(
      (sent) => sent.owned && sent.deviceCode === code && sent.status === 'online',
    ),
  );

const openEpisodes = async (dedupeKey: string): Promise<number> => {
  const result = await admin.query<{ n: string }>(
    `SELECT count(*) AS n FROM core.alarm_events WHERE dedupe_key = $1 AND cleared_at IS NULL`,
    [dedupeKey],
  );
  return Number(result.rows[0]?.n ?? 0);
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

  kafka = new Kafka({ clientId: 'scale-test', brokers: [brokers], logLevel: logLevel.NOTHING });
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

describe('два процессора в одной группе', () => {
  it('делят приборы без пересечений, а кадры и циклы каждого прибора ведёт его владелец', async () => {
    const first = await startProcessor('p1');
    const second = await startProcessor('p2');
    const [one, two] = await settle([first, second]);
    if (one === undefined || two === undefined) throw new Error('нет раскладки экземпляров');

    for (const view of [one, two]) {
      expect(sortedNumbers(view.assignment[CYCLES] ?? [])).toEqual(
        sortedNumbers(view.assignment[RAW] ?? []),
      );
      expect(view.ownership.partitions.length).toBeGreaterThan(0);
      expect([...view.ownership.devices].sort()).toEqual(
        devicesOf(view.ownership.partitions).sort(),
      );
    }
    expect([...one.ownership.devices].filter((code) => two.ownership.devices.has(code))).toEqual(
      [],
    );
    expect([...one.ownership.devices, ...two.ownership.devices].sort()).toEqual(
      [...STAND_CODES].sort(),
    );

    const chosenOne = [...one.ownership.devices].slice(0, 2);
    const chosenTwo = [...two.ownership.devices].slice(0, 2);
    const chosen = [...chosenOne, ...chosenTwo];
    for (const deviceCode of chosen) {
      cursorMs += 10_000;
      const framePartition = await publishFrame(frameOf(deviceCode, cursorMs));
      const cyclePartition = await publishCycle(okCycleOf(deviceCode));

      expect(framePartition).toBe(partitionForKey(deviceCode, PARTITIONS));
      expect(cyclePartition).toBe(framePartition);
    }

    await waitFor('приборы обеих половин online с временем успеха', async () => {
      const result = await admin.query<{ status: string; last_ok_at: Date | null }>(
        `SELECT s.status, s.last_ok_at
         FROM core.device_state s JOIN core.devices d ON d.id = s.device_id
         WHERE d.code = ANY($1::text[])`,
        [chosen],
      );
      return (
        result.rows.length === chosen.length &&
        result.rows.every((row) => row.status === 'online' && row.last_ok_at !== null)
      );
    });

    const readings = await admin.query<{ code: string }>(
      `SELECT DISTINCT d.code FROM ts.readings r JOIN core.devices d ON d.id = r.device_id
       WHERE d.code = ANY($1::text[])`,
      [chosen],
    );
    expect(readings.rows.map((row) => row.code).sort()).toEqual([...chosen].sort());

    await waitFor('online каждой половины отправил её владелец', () =>
      Promise.resolve(sentOnline(first, chosenOne) && sentOnline(second, chosenTwo)),
    );
    expect(sentOnline(first, chosenTwo) || sentOnline(second, chosenOne)).toBe(false);
    expect(foreignStates(first)).toEqual([]);
    expect(foreignStates(second)).toEqual([]);
  });

  /**
   * Эпизод появляется в базе, когда оба экземпляра уже работают, поэтому ни запуск, ни их первые
   * назначения его не видели. Снять его первый экземпляр может, только если восстановил состояние
   * прибора в момент, когда партиция переехала к нему.
   */
  it('открытый эпизод переезжает вместе с партицией и снимается новым владельцем', async () => {
    const first = await startProcessor('p1');
    const second = await startProcessor('p2');
    const [one, two] = await settle([first, second]);
    const deviceCode = COOLERS.find((code) => two?.ownership.devices.has(code) === true);
    if (one === undefined || deviceCode === undefined) {
      throw new Error('у второго экземпляра нет ни одной холодильной камеры');
    }
    expect(one.ownership.devices.has(deviceCode)).toBe(false);

    const raisedAtMs = cursorMs;
    const dedupeKey = alarmDedupeKey({
      deviceCode,
      metricKey: 'supply_temp_c',
      mode: 'cooling',
      raisedAt: raisedAtMs,
    });
    await admin.query(
      `INSERT INTO core.alarm_events (id, device_id, metric_key, mode, severity, boundary,
         value, threshold, occurred_at, dedupe_key)
       SELECT $1::uuid, d.id, 'supply_temp_c', 'cooling', 'warning', 'max', 9.9, 2, $3, $4
       FROM core.devices d WHERE d.code = $2`,
      [alarmIdOf(dedupeKey), deviceCode, new Date(raisedAtMs).toISOString(), dedupeKey],
    );
    expect(await openEpisodes(dedupeKey)).toBe(1);

    await stopProcessor(second);
    const [alone] = await settle([first]);
    expect(alone?.ownership.devices.size).toBe(STAND_CODES.length);

    for (const frame of series(deviceCode, 4)) await publishFrame(frame);

    await waitFor(
      'эпизод снят новым владельцем',
      async () => (await openEpisodes(dedupeKey)) === 0,
    );
    expect(foreignStates(first)).toEqual([]);
  });
});
