import { Inject, Injectable } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { AssignerProtocol } from 'kafkajs';
import type { Admin, GroupDescription } from 'kafkajs';
import { TOPICS, TOPIC_NAMES } from '@fieldstream/contracts';
import type {
  PipelineGroup,
  PipelineMember,
  PipelineResponse,
  PipelineTopic,
} from '@fieldstream/contracts';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import type { Logger } from '@fieldstream/nest-common';
import type { Env } from '../config/env.js';
import { LiveBusService } from '../events/live-bus.service.js';
import type { GatewayMetrics } from '../metrics/metrics.js';
import { ProducerService } from '../publish/producer.service.js';
import { CLOCK, ENV, LOGGER, METRICS } from '../tokens.js';
import {
  appendRebalances,
  groupLag,
  isStaleGatewayGroup,
  lagSeconds,
  ratePerSec,
  totalLag,
  trackRebalances,
} from './pipeline-calc.js';
import type { PartitionEnd, Reading, SettledShapes } from './pipeline-calc.js';

export type PipelineView = Pick<
  PipelineResponse,
  'sampledAt' | 'brokerError' | 'topics' | 'groups' | 'rebalances'
>;

interface Sample {
  readonly atMs: number;
  readonly highs: ReadonlyMap<string, number>;
  readonly settled: SettledShapes;
}

const TOPIC_SPECS = Object.values(TOPICS);

/** Раскладка участника. Пустой буфер означает, что раскладки ещё нет. */
const assignmentsOf = (buffer: Buffer): PipelineMember['assignments'] => {
  if (buffer.length === 0) return [];

  const decoded = AssignerProtocol.MemberAssignment.decode(buffer);
  if (decoded === null) return [];

  return Object.entries(decoded.assignment)
    .map(([topic, partitions]) => ({ topic, partitions: [...partitions].sort((a, b) => a - b) }))
    .sort((left, right) => left.topic.localeCompare(right.topic));
};

/** Участники группы. Раскладку понимает только протокол обычных потребителей. */
const membersOf = (group: GroupDescription): PipelineMember[] =>
  group.members
    .map((member) => ({
      memberId: member.memberId,
      clientId: member.clientId,
      host: member.clientHost,
      assignments: group.protocolType === 'consumer' ? assignmentsOf(member.memberAssignment) : [],
    }))
    .sort((left, right) => left.memberId.localeCompare(right.memberId));

/**
 * Опрос брокера для экрана конвейера: концы логов, группы, раскладка и отставание.
 * Недоступный брокер не стирает снимок: остаётся последний удачный и текст ошибки.
 */
@Injectable()
export class PipelineSamplerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly admin: Admin;
  private timer: NodeJS.Timeout | null = null;
  private connected = false;
  private running: Promise<void> | null = null;
  private view: PipelineView = {
    sampledAt: null,
    brokerError: null,
    topics: [],
    groups: [],
    rebalances: [],
  };
  private last: Sample | null = null;
  private events: Reading | null = null;
  private eventsRate = 0;

  public constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(METRICS) private readonly metrics: GatewayMetrics,
    producer: ProducerService,
    private readonly bus: LiveBusService,
  ) {
    this.admin = producer.kafka.admin({
      retry: { retries: 1, initialRetryTime: 300, maxRetryTime: 1_000 },
    });
  }

  public onApplicationBootstrap(): void {
    if (this.env.PIPELINE_SAMPLER === 'off') {
      this.log.info({}, 'опрос конвейера выключен: снимок брокера не собирается');
      return;
    }

    void this.sample();
    this.timer = setInterval(() => {
      void this.sample();
    }, this.env.PIPELINE_POLL_MS);
    this.timer.unref();
  }

  public async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.running !== null) await this.running;
    if (!this.connected) return;

    this.connected = false;
    await this.admin.disconnect();
  }

  public current(): PipelineView {
    return this.view;
  }

  public eventsPerSec(): number {
    return this.eventsRate;
  }

  /** Один опрос. Идущий опрос не дублируется: повторный вызов ждёт его же. */
  public sample(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });

    return this.running;
  }

  private async run(): Promise<void> {
    const nowMs = this.clock.now();
    this.observeEvents(nowMs);

    try {
      if (!this.connected) {
        await this.admin.connect();
        this.connected = true;
      }
      await this.collect(nowMs);
    } catch (error) {
      const message = error instanceof Error && error.message.length > 0 ? error.message : null;
      if (this.view.brokerError === null) {
        this.log.warn({ err: error }, 'опрос конвейера не удался, остаётся последний снимок');
      }
      this.view = { ...this.view, brokerError: message ?? 'брокер недоступен' };

      if (this.connected) {
        this.connected = false;
        await this.admin.disconnect().catch(() => undefined);
      }
    }
  }

  private observeEvents(nowMs: number): void {
    const current = { value: this.bus.publishedEvents(), atMs: nowMs };
    const rate = ratePerSec(this.events, current);
    if (rate !== null) this.eventsRate = rate;
    this.events = current;
  }

  /** Полный снимок брокера. Любая ошибка оставляет прежний снимок нетронутым. */
  private async collect(nowMs: number): Promise<void> {
    const previous = this.last;
    const ends = new Map<string, PartitionEnd[]>(
      await Promise.all(
        TOPIC_SPECS.map(async (spec): Promise<[string, PartitionEnd[]]> => {
          const offsets = await this.admin.fetchTopicOffsets(spec.name);
          const partitions = offsets
            .map((item) => ({
              partition: item.partition,
              low: Number(item.low),
              high: Number(item.high),
            }))
            .sort((left, right) => left.partition - right.partition);
          return [spec.name, partitions];
        }),
      ),
    );
    const highs = new Map(
      [...ends].map(([name, partitions]) => [
        name,
        partitions.reduce((sum, item) => sum + item.high, 0),
      ]),
    );

    const topics: PipelineTopic[] = TOPIC_SPECS.map((spec) => {
      const before = previous?.highs.get(spec.name);
      const current = { value: highs.get(spec.name) ?? 0, atMs: nowMs };

      return {
        name: spec.name,
        owner: spec.owner,
        cleanupPolicy: spec.cleanupPolicy,
        partitions: ends.get(spec.name) ?? [],
        messagesPerSec:
          previous === null || before === undefined
            ? null
            : ratePerSec({ value: before, atMs: previous.atMs }, current),
      };
    });
    const rates = new Map(topics.map((topic) => [topic.name, topic.messagesPerSec]));

    const { groups: listed } = await this.admin.listGroups();
    const described =
      listed.length === 0
        ? []
        : (await this.admin.describeGroups(listed.map((group) => group.groupId))).groups;
    const visible = described
      .filter((group) => !isStaleGatewayGroup(group.groupId, group.state))
      .sort((left, right) => left.groupId.localeCompare(right.groupId));

    const groups = await Promise.all(
      visible.map(async (group): Promise<PipelineGroup> => {
        const members = membersOf(group);
        const committed = await this.admin.fetchOffsets({
          groupId: group.groupId,
          topics: [...TOPIC_NAMES],
        });
        const lag = groupLag(ends, committed, members);
        const total = totalLag(lag);
        const groupTopics = [...new Set(lag.map((row) => row.topic))];

        return {
          groupId: group.groupId,
          state: group.state,
          members,
          lag,
          totalLag: total,
          lagSeconds: lagSeconds(
            total,
            groupTopics.map((topic) => rates.get(topic) ?? null),
          ),
        };
      }),
    );

    const at = toIsoTimestamp(nowMs);
    const { settled, rebalances: fresh } = trackRebalances(
      previous?.settled ?? null,
      new Map(groups.map((group) => [group.groupId, group])),
      at,
    );
    if (fresh.length > 0) this.log.info({ rebalances: fresh }, 'замечена смена состава групп');

    this.metrics.setConsumerLag(
      groups.flatMap((group) =>
        group.lag.flatMap((row) =>
          row.lag === null
            ? []
            : [{ group: group.groupId, topic: row.topic, partition: row.partition, lag: row.lag }],
        ),
      ),
    );
    this.last = { atMs: nowMs, highs, settled };
    this.view = {
      sampledAt: at,
      brokerError: null,
      topics,
      groups,
      rebalances: appendRebalances(this.view.rebalances, fresh),
    };
  }
}
