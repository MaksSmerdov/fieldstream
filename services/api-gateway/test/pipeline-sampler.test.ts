import { AssignerProtocol } from 'kafkajs';
import type { Admin, GroupDescription } from 'kafkajs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOPICS, TOPIC_NAMES } from '@fieldstream/contracts';
import { createFakeClock, toIsoTimestamp } from '@fieldstream/domain';
import { createLogger } from '@fieldstream/nest-common';
import { loadEnv } from '../src/config/env.js';
import type { LiveBusService } from '../src/events/live-bus.service.js';
import { createMetrics } from '../src/metrics/metrics.js';
import { PipelineSamplerService } from '../src/pipeline/pipeline-sampler.service.js';
import type { ProducerService } from '../src/publish/producer.service.js';

const SECRET = 'секрет стенда длиной не меньше тридцати двух символов';
const TOPIC = TOPICS.pollCycles.name;
const GROUP = 'fs-processor-cycles';

interface FakeBroker {
  down: Error | null;
  offsetsError: Error | null;
  highs: number[];
  groups: GroupDescription[];
}

/** Участник группы с раскладкой в формате протокола потребителей. */
const memberOf = (
  memberId: string,
  partitions: readonly number[],
): GroupDescription['members'][number] => ({
  memberId,
  clientId: 'stream-processor',
  clientHost: '/10.0.0.1',
  memberAssignment:
    partitions.length === 0
      ? Buffer.alloc(0)
      : AssignerProtocol.MemberAssignment.encode({
          version: 0,
          assignment: { [TOPIC]: [...partitions] },
          userData: Buffer.alloc(0),
        }),
  memberMetadata: Buffer.alloc(0),
});

/** Описание группы в заданном состоянии. */
const groupOf = (
  state: GroupDescription['state'],
  members: GroupDescription['members'],
): GroupDescription => ({
  groupId: GROUP,
  members,
  protocol: 'RoundRobinAssigner',
  protocolType: 'consumer',
  state,
});

/** Сервис опроса над поддельным брокером, которым тест управляет напрямую. */
const setup = (overrides: Record<string, string> = {}) => {
  const clock = createFakeClock(1_770_000_000_000);
  const broker: FakeBroker = {
    down: null,
    offsetsError: null,
    highs: [10, 20],
    groups: [groupOf('Stable', [memberOf('m-1', [0, 1])])],
  };
  const guard = (): Promise<void> =>
    broker.down === null ? Promise.resolve() : Promise.reject(broker.down);

  const admin = {
    connect: vi.fn(guard),
    disconnect: vi.fn(() => Promise.resolve()),
    fetchTopicOffsets: vi.fn(async (topic: string) => {
      await guard();
      if (broker.offsetsError !== null) throw broker.offsetsError;
      const highs = topic === TOPIC ? broker.highs : [0];
      return highs.map((high, partition) => ({
        partition,
        offset: String(high),
        high: String(high),
        low: '0',
      }));
    }),
    listGroups: vi.fn(async () => {
      await guard();
      return {
        groups: broker.groups.map((group) => ({
          groupId: group.groupId,
          protocolType: 'consumer',
        })),
      };
    }),
    describeGroups: vi.fn(async () => {
      await guard();
      return { groups: broker.groups };
    }),
    fetchOffsets: vi.fn(async () => {
      await guard();
      return [
        {
          topic: TOPIC,
          partitions: [
            { partition: 0, offset: '4', metadata: null },
            { partition: 1, offset: '-1', metadata: null },
          ],
        },
      ];
    }),
  };

  const producer = {
    kafka: { admin: () => admin as unknown as Admin },
  } as unknown as ProducerService;
  const bus = { publishedEvents: () => 0 } as unknown as LiveBusService;
  const sampler = new PipelineSamplerService(
    loadEnv({ FS_API_PASSWORD: 'тест', AUTH_SECRET: SECRET, ...overrides }),
    createLogger('api-gateway', 'fatal'),
    clock,
    createMetrics(),
    producer,
    bus,
  );

  return { clock, broker, admin, sampler };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('опрос конвейера при сбоях брокера', () => {
  it('до первого удачного опроса снимок пуст, а ошибка брокера видна', async () => {
    const { broker, admin, sampler } = setup();
    broker.down = new Error('Connection error: connect ECONNREFUSED 127.0.0.1:9092');

    await sampler.sample();

    expect(sampler.current()).toEqual({
      sampledAt: null,
      brokerError: 'Connection error: connect ECONNREFUSED 127.0.0.1:9092',
      topics: [],
      groups: [],
      rebalances: [],
    });
    expect(admin.connect).toHaveBeenCalledTimes(1);
    expect(admin.disconnect).not.toHaveBeenCalled();
  });

  it('сбой после удачного опроса оставляет прежний снимок, а клиент затем подключается заново', async () => {
    const { clock, broker, admin, sampler } = setup();

    await sampler.sample();
    const good = sampler.current();
    expect(good.brokerError).toBeNull();
    expect(good.sampledAt).toBe(toIsoTimestamp(clock.now()));
    expect(good.topics).toHaveLength(TOPIC_NAMES.length);
    expect(good.groups.map((group) => [group.groupId, group.totalLag])).toEqual([[GROUP, 6]]);

    clock.advance(2_000);
    broker.offsetsError = new Error('This server is not the leader for that topic-partition');
    await sampler.sample();

    expect(sampler.current()).toEqual({
      ...good,
      brokerError: 'This server is not the leader for that topic-partition',
    });
    expect(admin.disconnect).toHaveBeenCalledTimes(1);

    clock.advance(2_000);
    broker.offsetsError = null;
    broker.highs = [16, 26];
    await sampler.sample();

    const recovered = sampler.current();
    expect(admin.connect).toHaveBeenCalledTimes(2);
    expect(recovered.brokerError).toBeNull();
    expect(recovered.sampledAt).toBe(toIsoTimestamp(clock.now()));
    expect(recovered.topics.find((topic) => topic.name === TOPIC)?.messagesPerSec).toBe(3);
  });

  it('ребаланс через промежуточное состояние попадает в журнал одной записью', async () => {
    const { clock, broker, sampler } = setup();

    await sampler.sample();
    clock.advance(2_000);
    broker.groups = [groupOf('PreparingRebalance', [memberOf('m-1', []), memberOf('m-2', [])])];
    await sampler.sample();

    const during = sampler.current();
    expect(during.rebalances).toEqual([]);
    expect(during.groups[0]?.lag.map((row) => row.memberId)).toEqual([null, null]);

    clock.advance(2_000);
    broker.groups = [groupOf('Stable', [memberOf('m-1', [0]), memberOf('m-2', [1])])];
    await sampler.sample();
    clock.advance(2_000);
    await sampler.sample();

    expect(sampler.current().rebalances).toEqual([
      {
        groupId: GROUP,
        at: toIsoTimestamp(clock.now() - 2_000),
        membersBefore: 1,
        membersAfter: 2,
      },
    ]);
  });
});

describe('темп топиков', () => {
  it('пачка сообщений не превращает темп в ноль на следующем опросе: темп считается по окну', async () => {
    const { clock, broker, sampler } = setup();
    const rate = (): number | null | undefined =>
      sampler.current().topics.find((topic) => topic.name === TOPIC)?.messagesPerSec;

    await sampler.sample();
    clock.advance(2_000);
    broker.highs = [20, 30];
    await sampler.sample();
    expect(rate()).toBe(10);

    clock.advance(2_000);
    await sampler.sample();
    expect(rate()).toBe(5);
  });

  it('замеры старше окна в темп не входят', async () => {
    const { clock, broker, sampler } = setup();

    await sampler.sample();
    clock.advance(40_000);
    broker.highs = [30, 40];
    await sampler.sample();
    clock.advance(2_000);
    broker.highs = [34, 40];
    await sampler.sample();

    expect(sampler.current().topics.find((topic) => topic.name === TOPIC)?.messagesPerSec).toBe(2);
  });
});

describe('фоновый опрос', () => {
  it('выключенный опрос к брокеру не обращается', () => {
    const { admin, sampler } = setup({ PIPELINE_SAMPLER: 'off' });

    sampler.onApplicationBootstrap();

    expect(admin.connect).not.toHaveBeenCalled();
  });

  it('стартует сразу, повторяется с заданным периодом и останавливается вместе с приложением', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { admin, sampler } = setup({ PIPELINE_POLL_MS: '500' });

    sampler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(admin.listGroups).toHaveBeenCalledTimes(3);

    await sampler.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(admin.listGroups).toHaveBeenCalledTimes(3);
    expect(admin.disconnect).toHaveBeenCalledTimes(1);
  });
});
