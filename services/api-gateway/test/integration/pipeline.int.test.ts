import net from 'node:net';
import type pg from 'pg';
import { Kafka, logLevel } from 'kafkajs';
import type { Admin, Consumer, Producer } from 'kafkajs';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOPICS, pipelineResponseSchema } from '@fieldstream/contracts';
import type { PipelineGroup, PipelineResponse, PipelineTopic } from '@fieldstream/contracts';
import { SystemClock, createFakeClock, toIsoTimestamp } from '@fieldstream/domain';
import { createProducer } from '@fieldstream/kafka';
import { createLogger } from '@fieldstream/nest-common';
import { deriveKeys, issueAccessToken } from '../../src/auth/tokens.js';
import { createApp } from '../../src/bootstrap.js';
import { loadEnv } from '../../src/config/env.js';
import { createMetrics } from '../../src/metrics/metrics.js';
import type { GatewayMetrics } from '../../src/metrics/metrics.js';
import { PipelineSamplerService } from '../../src/pipeline/pipeline-sampler.service.js';

const KAFKA_IMAGE = 'apache/kafka:3.9.0';
const SECRET = 'секрет стенда длиной не меньше тридцати двух символов';
const TOPIC = TOPICS.pollCycles.name;
const GROUP = 'pipeline-int-readers';
const WRITTEN = [4, 8, 12, 16, 20, 24];
const COMMITTED = [2, 4, 6, 8, 10, 12];

const clock = createFakeClock(SystemClock.now());
const client = {
  query: (sql: string) =>
    Promise.resolve({
      rows: sql.includes('core.dlq_message') ? [{ unresolved: '1', total: '3' }] : [],
    }),
  release: () => undefined,
};
const pool = { connect: () => Promise.resolve(client) } as unknown as pg.Pool;

let broker: StartedTestContainer;
let kafka: Kafka;
let kafkaAdmin: Admin;
let producer: Producer;
let app: NestFastifyApplication;
let sampler: PipelineSamplerService;
let metrics: GatewayMetrics;
let base: string;
let token: string;
const consumers: Consumer[] = [];

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

/** Сообщения с ключами в явно заданные партиции: так ожидаемый лаг известен точно. */
const write = async (perPartition: readonly number[]): Promise<void> => {
  await producer.send({
    topic: TOPIC,
    messages: perPartition.flatMap((count, partition) =>
      Array.from({ length: count }, (_, index) => ({
        key: `RC-${String(101 + partition)}`,
        partition,
        value: JSON.stringify({ partition, index }),
      })),
    ),
  });
};

/** Участник группы, который читает всё и сам ничего не подтверждает. */
const startReader = async (): Promise<{ consumer: Consumer; seen: () => number }> => {
  const consumer = kafka.consumer({
    groupId: GROUP,
    sessionTimeout: 10_000,
    heartbeatInterval: 500,
    maxWaitTimeInMs: 500,
    allowAutoTopicCreation: false,
  });
  consumers.push(consumer);
  let seen = 0;

  await consumer.connect();
  await consumer.subscribe({ topics: [TOPIC], fromBeginning: true });
  await consumer.run({
    autoCommit: false,
    eachMessage: () => {
      seen += 1;
      return Promise.resolve();
    },
  });

  return { consumer, seen: () => seen };
};

/** Опрос брокера и ответ шлюза, разобранный схемой контракта. */
const snapshot = async (): Promise<PipelineResponse> => {
  await sampler.sample();
  const response = await fetch(`${base}/api/pipeline`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);

  return pipelineResponseSchema.parse(await response.json());
};

const groupOf = (response: PipelineResponse): PipelineGroup => {
  const group = response.groups.find((item) => item.groupId === GROUP);
  if (group === undefined) throw new Error(`группы ${GROUP} нет в снимке`);
  return group;
};

const topicOf = (response: PipelineResponse): PipelineTopic => {
  const topic = response.topics.find((item) => item.name === TOPIC);
  if (topic === undefined) throw new Error(`топика ${TOPIC} нет в снимке`);
  return topic;
};

/** Значение метрики отставания по партиции группы. */
const lagMetric = async (partition: number): Promise<number | undefined> => {
  const metric = metrics.registry.getSingleMetric('fieldstream_consumer_lag');
  const values = (await metric?.get())?.values ?? [];

  return values.find(
    (item) =>
      item.labels['group'] === GROUP &&
      item.labels['topic'] === TOPIC &&
      String(item.labels['partition']) === String(partition),
  )?.value;
};

beforeAll(async () => {
  const hostPort = await freePort();
  broker = await new GenericContainer(KAFKA_IMAGE)
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
    .start();
  const brokers = `localhost:${String(hostPort)}`;

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

  metrics = createMetrics();
  app = await createApp({
    env: loadEnv({
      KAFKA_BROKERS: brokers,
      FS_API_PASSWORD: 'тест',
      AUTH_SECRET: SECRET,
      SSE_BRIDGE: 'off',
      OUTBOX_RELAY: 'off',
      COLLECTOR_STATUS: 'off',
      PIPELINE_SAMPLER: 'off',
      LOG_LEVEL: 'fatal',
    }),
    log: createLogger('api-gateway', 'fatal'),
    clock,
    metrics,
    pool,
    instanceId: 'test',
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  sampler = app.get(PipelineSamplerService);

  token = (
    await issueAccessToken(
      deriveKeys(SECRET),
      {
        userId: 'ba0ba102-a143-4f6c-8538-47bded9939fb',
        email: 'viewer@fieldstream.local',
        sessionId: 'сессия',
        role: 'viewer',
        permissions: ['pipeline'],
      },
      clock.now(),
      3_600_000,
    )
  ).token;
});

afterAll(async () => {
  await Promise.all(consumers.map((consumer) => consumer.disconnect()));
  await app.close();
  await producer.disconnect();
  await kafkaAdmin.disconnect();
  await broker.stop();
});

describe('снимок конвейера на настоящем брокере', () => {
  it('лаг по партициям, участник и его раскладка видны после первого опроса', async () => {
    await write(WRITTEN);
    const reader = await startReader();
    const written = WRITTEN.reduce((sum, count) => sum + count, 0);
    await waitFor('участник дочитал топик', () => Promise.resolve(reader.seen() === written));
    await reader.consumer.commitOffsets(
      COMMITTED.map((offset, partition) => ({ topic: TOPIC, partition, offset: String(offset) })),
    );

    const response = await snapshot();

    expect(response.brokerError).toBeNull();
    expect(response.sampledAt).toBe(toIsoTimestamp(clock.now()));
    expect(response.dlq).toEqual({ unresolved: 1, total: 3 });
    expect(response.topics.map((topic) => topic.name)).toEqual(
      Object.values(TOPICS).map((spec) => spec.name),
    );
    expect(topicOf(response).partitions).toEqual([
      { partition: 0, low: 0, high: 4 },
      { partition: 1, low: 0, high: 8 },
      { partition: 2, low: 0, high: 12 },
      { partition: 3, low: 0, high: 16 },
      { partition: 4, low: 0, high: 20 },
      { partition: 5, low: 0, high: 24 },
    ]);
    expect(topicOf(response).messagesPerSec).toBeNull();
    expect(response.rebalances).toEqual([]);

    const group = groupOf(response);
    const memberId = group.members[0]?.memberId;
    expect(group.state).toBe('Stable');
    expect(group.members).toHaveLength(1);
    expect(group.members[0]?.assignments).toEqual([
      { topic: TOPIC, partitions: [0, 1, 2, 3, 4, 5] },
    ]);
    expect(group.lag).toEqual([
      { topic: TOPIC, partition: 0, committed: 2, high: 4, lag: 2, memberId },
      { topic: TOPIC, partition: 1, committed: 4, high: 8, lag: 4, memberId },
      { topic: TOPIC, partition: 2, committed: 6, high: 12, lag: 6, memberId },
      { topic: TOPIC, partition: 3, committed: 8, high: 16, lag: 8, memberId },
      { topic: TOPIC, partition: 4, committed: 10, high: 20, lag: 10, memberId },
      { topic: TOPIC, partition: 5, committed: 12, high: 24, lag: 12, memberId },
    ]);
    expect(group.totalLag).toBe(42);
    expect(group.lagSeconds).toBeNull();
    expect(await lagMetric(2)).toBe(6);
  });

  it('после второго опроса у топика есть темп, а у группы оценка секунд', async () => {
    await write([2, 2, 2, 2, 2, 2]);
    clock.advance(2_000);

    const response = await snapshot();
    const group = groupOf(response);

    expect(topicOf(response).messagesPerSec).toBe(6);
    expect(
      response.topics.filter((topic) => topic.name !== TOPIC).map((topic) => topic.messagesPerSec),
    ).toEqual(Array.from({ length: response.topics.length - 1 }, () => 0));
    expect(group.totalLag).toBe(54);
    expect(group.lagSeconds).toBe(9);
    expect(await lagMetric(0)).toBe(4);
    expect(await lagMetric(5)).toBe(14);
  });

  it('вход второго участника в группу виден как ребаланс с одного на двух', async () => {
    await startReader();

    await waitFor('ребаланс замечен и группа устоялась', async () => {
      clock.advance(1_000);
      const response = await snapshot();
      const group = groupOf(response);
      const assigned = group.members.flatMap((member) =>
        member.assignments.flatMap((assignment) => assignment.partitions),
      );

      return (
        response.rebalances.some(
          (entry) =>
            entry.groupId === GROUP && entry.membersBefore === 1 && entry.membersAfter === 2,
        ) &&
        group.state === 'Stable' &&
        group.members.length === 2 &&
        assigned.length === WRITTEN.length
      );
    });

    const response = await snapshot();
    const owners = new Set(groupOf(response).lag.map((row) => row.memberId));
    expect(owners.size).toBe(2);
    expect(
      response.rebalances
        .filter((entry) => entry.groupId === GROUP)
        .map((entry) => [entry.membersBefore, entry.membersAfter]),
    ).toEqual([[1, 2]]);
  });
});
