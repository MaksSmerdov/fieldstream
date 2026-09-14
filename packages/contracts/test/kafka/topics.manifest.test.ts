import { describe, expect, it } from 'vitest';
import type { PayloadOf, TopicKey } from '../../src/kafka/topics.manifest.js';
import { KAFKA_HEADERS, TOPIC_NAMES, TOPICS } from '../../src/kafka/topics.manifest.js';

const TS = '2026-09-11T10:00:00.000Z';
const TRACE_ID = '0123456789abcdef';

/** Общая часть манифеста без схемы и ключа: по ней проверяются инварианты всех топиков разом. */
interface TopicShape {
  readonly name: string;
  readonly partitions: number;
  readonly cleanupPolicy: 'delete' | 'compact';
  readonly retentionMs: number | null;
  readonly configs?: Readonly<Record<string, string>>;
  readonly owner: string;
  readonly why: string;
}

const SPECS: readonly TopicShape[] = Object.values(TOPICS);

/** Сервисы, которым вообще разрешено писать в шину. */
const WRITERS: readonly string[] = ['edge-collector', 'stream-processor', 'api-gateway'];

/** Примеры payload по топикам. Новый топик без примера не соберётся: тип требует все ключи. */
const SAMPLES: { readonly [K in TopicKey]: PayloadOf<K> } = {
  telemetryRaw: {
    schema: 'telemetry.raw',
    v: 1,
    ts: TS,
    siteCode: 'SITE-A',
    gatewayCode: 'GW-01',
    lineCode: 'L1',
    deviceCode: 'RC-101',
    slaveId: 12,
    profileKey: 'rc-2000',
    profileVersion: 1,
    blocks: [{ registerType: 'holding', startAddress: 0, words: [65_535, 0, 12] }],
    cycleMs: 180,
    traceId: TRACE_ID,
  },
  pollCycles: {
    schema: 'poll.cycle',
    v: 1,
    ts: TS,
    lineCode: 'L1',
    deviceCode: 'RC-101',
    ok: false,
    errorKind: 'timeout',
    durationMs: 1_500,
    requestCount: 2,
    planMode: 'merged',
    traceId: TRACE_ID,
  },
  lineStatus: {
    schema: 'line.status',
    v: 1,
    ts: TS,
    lineCode: 'L1',
    running: true,
    connected: true,
    planMode: 'merged',
    pollIntervalMs: 10_000,
    requestTimeoutMs: 600,
    hardTimeoutMs: 1_450,
    watchdog: { limitMs: 300_000, cycleStartedAt: TS, trips: 0 },
    lastCycle: { at: TS, outcome: 'polled', durationMs: 420, polled: 6, failed: 1 },
    reconnects: [{ attempt: 0, at: TS, baseMs: 1_000, jitterMs: -40, chosenMs: 960 }],
    devices: [
      {
        deviceCode: 'RC-105',
        slaveId: 5,
        breaker: { state: 'open', failures: 2, probeDelayMs: 30_000, nextProbeAt: TS },
      },
    ],
    latency: {
      bucketsMs: [50, 100, 200],
      counts: [10, 30, 2, 0],
      samples: 42,
      timeouts: 3,
      p50Ms: 64,
      p95Ms: 140,
      p99Ms: 180,
      suggestedTimeoutMs: 900,
    },
  },
  telemetryReadings: {
    schema: 'telemetry.reading',
    v: 1,
    deviceCode: 'RC-101',
    ts: TS,
    mode: 'cooling',
    metrics: { supply_temp_c: -18.4, door_state: null },
    quality: 'ok',
    sourceOffset: { partition: 2, offset: '184' },
    traceId: TRACE_ID,
  },
  deviceState: {
    schema: 'device.state',
    v: 1,
    deviceCode: 'RC-101',
    status: 'online',
    reason: 'ok',
    since: TS,
    mode: 'cooling',
    lastOkAt: TS,
    consecutiveErrors: 0,
  },
  alarmEvents: {
    schema: 'alarm.event',
    v: 1,
    alarmId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    dedupeKey: 'RC-101|supply_temp_c|cooling|raised|2026-09-11T10:00:00.000Z',
    deviceCode: 'RC-101',
    metricKey: 'supply_temp_c',
    mode: 'cooling',
    state: 'raised',
    severity: 'critical',
    value: -8.2,
    threshold: -15,
    boundary: 'max',
    occurredAt: TS,
    traceId: TRACE_ID,
  },
  deviceCommands: {
    schema: 'device.command',
    v: 1,
    commandId: 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e',
    issuedBy: 'engineer@fieldstream.local',
    siteCode: 'SITE-A',
    lineCode: 'L1',
    kind: 'line.set_poll_interval',
    args: { pollIntervalMs: 15_000 },
    issuedAt: TS,
    expiresAt: TS,
    traceId: TRACE_ID,
  },
  commandResults: {
    schema: 'device.command.result',
    v: 1,
    commandId: 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e',
    siteCode: 'SITE-A',
    lineCode: 'L1',
    kind: 'line.set_poll_interval',
    status: 'applied',
    detail: 'такт опроса линии L1 теперь 15000 мс',
    appliedAt: TS,
    traceId: TRACE_ID,
  },
  telemetryRawDlq: new Uint8Array([0x7b, 0xff, 0x00]),
};

describe('манифест топиков', () => {
  it('имя топика непустое, с префиксом системы и версией схемы', () => {
    const wrong = SPECS.map((spec) => spec.name).filter(
      (name) => !/^fieldstream\.[a-z0-9]+(\.[a-z0-9]+)*\.v1$/.test(name),
    );

    expect(wrong).toEqual([]);
    expect(SPECS.every((spec) => spec.name.startsWith('fieldstream.'))).toBe(true);
    expect(SPECS.every((spec) => spec.name.endsWith('.v1'))).toBe(true);
  });

  it('имена топиков уникальны и совпадают со списком TOPIC_NAMES', () => {
    const names = SPECS.map((spec) => spec.name);

    expect(new Set(names).size).toBe(names.length);
    expect([...TOPIC_NAMES].sort()).toEqual([...names].sort());
  });

  it('у каждого топика объявлен ровно один владелец из числа сервисов', () => {
    const ownerless = SPECS.filter((spec) => spec.owner.trim().length === 0).map(
      (spec) => spec.name,
    );
    const foreign = SPECS.filter((spec) => !WRITERS.includes(spec.owner)).map((spec) => spec.name);

    expect(ownerless).toEqual([]);
    expect(foreign).toEqual([]);
    expect(TOPICS.telemetryRaw.owner).toBe('edge-collector');
    expect(TOPICS.telemetryReadings.owner).toBe('stream-processor');
  });

  it('у компактируемого топика состояния нет retention, у остальных он задан', () => {
    expect(TOPICS.deviceState.cleanupPolicy).toBe('compact');
    expect(TOPICS.deviceState.retentionMs).toBeNull();

    const compactedWithRetention = SPECS.filter(
      (spec) => spec.cleanupPolicy === 'compact' && spec.retentionMs !== null,
    ).map((spec) => spec.name);
    const deletedWithoutRetention = SPECS.filter(
      (spec) =>
        spec.cleanupPolicy === 'delete' && (spec.retentionMs === null || spec.retentionMs <= 0),
    ).map((spec) => spec.name);

    expect(compactedWithRetention).toEqual([]);
    expect(deletedWithoutRetention).toEqual([]);
  });

  it('настройки топика не переопределяют политику очистки и срок хранения', () => {
    const clashing = SPECS.filter((spec) =>
      Object.keys(spec.configs ?? {}).some(
        (key) => key === 'cleanup.policy' || key === 'retention.ms',
      ),
    ).map((spec) => spec.name);

    expect(clashing).toEqual([]);
    expect(TOPICS.telemetryRaw.configs).toEqual({ 'compression.type': 'gzip' });
  });

  it('число партиций положительное целое', () => {
    const wrong = SPECS.filter(
      (spec) => !Number.isInteger(spec.partitions) || spec.partitions < 1,
    ).map((spec) => spec.name);

    expect(wrong).toEqual([]);
  });

  it('пример payload проходит схему своего топика', () => {
    expect(TOPICS.telemetryRaw.schema.safeParse(SAMPLES.telemetryRaw).success).toBe(true);
    expect(TOPICS.pollCycles.schema.safeParse(SAMPLES.pollCycles).success).toBe(true);
    expect(TOPICS.lineStatus.schema.safeParse(SAMPLES.lineStatus).success).toBe(true);
    expect(
      TOPICS.lineStatus.schema.safeParse({
        ...SAMPLES.lineStatus,
        latency: { ...SAMPLES.lineStatus.latency, counts: [10, 30, 2] },
      }).success,
    ).toBe(false);
    expect(TOPICS.telemetryReadings.schema.safeParse(SAMPLES.telemetryReadings).success).toBe(true);
    expect(TOPICS.deviceState.schema.safeParse(SAMPLES.deviceState).success).toBe(true);
    expect(TOPICS.alarmEvents.schema.safeParse(SAMPLES.alarmEvents).success).toBe(true);
    expect(TOPICS.telemetryRawDlq.schema.safeParse(SAMPLES.telemetryRawDlq).success).toBe(true);
    expect(TOPICS.telemetryRawDlq.schema.safeParse('не байты').success).toBe(false);
  });

  it('keyOf на валидном payload возвращает непустой ключ партиции', () => {
    const keys = [
      TOPICS.telemetryRaw.keyOf(SAMPLES.telemetryRaw),
      TOPICS.pollCycles.keyOf(SAMPLES.pollCycles),
      TOPICS.telemetryReadings.keyOf(SAMPLES.telemetryReadings),
      TOPICS.deviceState.keyOf(SAMPLES.deviceState),
      TOPICS.alarmEvents.keyOf(SAMPLES.alarmEvents),
    ];

    expect(keys.filter((key) => key.length === 0)).toEqual([]);
    expect(keys).toEqual(['RC-101', 'L1', 'RC-101', 'RC-101', 'RC-101']);
  });

  it('ключ компактируемого топика это идентификатор прибора', () => {
    expect(TOPICS.deviceState.keyOf(SAMPLES.deviceState)).toBe(SAMPLES.deviceState.deviceCode);
  });

  it('имена заголовков уникальны и все с префиксом x-', () => {
    const values = Object.values(KAFKA_HEADERS);

    expect(new Set(values).size).toBe(values.length);
    expect(values.filter((value) => !value.startsWith('x-'))).toEqual([]);
  });
});
