import type pg from 'pg';
import type { EachBatchPayload, KafkaMessage } from 'kafkajs';
import { describe, expect, it, vi } from 'vitest';
import { KAFKA_HEADERS, TOPICS, replayGroupIdOf } from '@fieldstream/contracts';
import type { AlarmRule, RawBlock, TelemetryRaw } from '@fieldstream/contracts';
import type { DeviceRef } from '@fieldstream/db';
import {
  buildDeviceReadPlan,
  buildSimulationValues,
  encodeSimulationRegisters,
  rc2000Profile,
  readSimulatedBlock,
} from '@fieldstream/device-profiles';
import { createFakeClock } from '@fieldstream/domain';
import type { FakeClock } from '@fieldstream/domain';
import { createLogger } from '@fieldstream/nest-common';
import type { DecodedValue } from '@fieldstream/modbus-codec';
import { loadEnv } from '../../src/config/env.js';
import type { Env } from '../../src/config/env.js';
import { INGEST_GROUP } from '../../src/ingest/assignment.js';
import { createMetrics } from '../../src/metrics/metrics.js';
import type { ProducerService } from '../../src/publish/producer.service.js';
import type { OffsetsByTime } from '../../src/replay/replay-offsets.js';
import {
  REPLAY_END_SLACK_MS,
  ReplayRunnerService,
  SHUTDOWN_REPLAY_ERROR,
  STALE_REPLAY_ERROR,
} from '../../src/replay/replay-runner.service.js';
import type { DeviceRefsService } from '../../src/topology/device-refs.service.js';

const START = Date.parse('2026-09-11T10:00:00Z');
const FROM_MS = START - 10 * 60_000;
const CYCLE_MS = 10_000;
const RAW = TOPICS.telemetryRaw.name;
const RUN_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const GROUP_ID = replayGroupIdOf(RUN_ID);
const INSTANCE = 'p1';

const env = (overrides: Record<string, string> = {}): Env =>
  loadEnv({
    FS_INGEST_PASSWORD: 'ingest-pw',
    REPLAY: 'on',
    REPLAY_POLL_MS: '100',
    REPLAY_HEARTBEAT_MS: '100',
    REPLAY_STALE_MS: '1000',
    REPLAY_MAX_MS: '60000',
    LOG_LEVEL: 'fatal',
    ...overrides,
  });

const REFS = new Map<string, DeviceRef>([
  ['RC-101', { deviceId: 1, lineId: 1, code: 'RC-101', lineCode: 'L1', siteCode: 'SITE-A' }],
]);
const REFS_SERVICE = { isLoaded: () => true, current: () => REFS } as unknown as DeviceRefsService;

const evapDefrost = (maxValue: number): AlarmRule => ({
  deviceCode: 'RC-101',
  metricKey: 'evap_temp_c',
  mode: 'defrost',
  minValue: -28,
  maxValue,
  hysteresis: 1,
  debounceCycles: 6,
  severity: 'info',
  enabled: true,
});

const RUN_ROW = {
  id: RUN_ID,
  requested_by: 'engineer@fieldstream.local',
  from_ts: new Date(FROM_MS),
  to_ts: new Date(START),
  device_codes: ['RC-101'],
  patches: [{ metricKey: 'evap_temp_c', mode: 'defrost', maxValue: 8 }],
  status: 'running',
  offsets_total: '0',
  offsets_done: '0',
  frames_matched: 0,
  frames_rejected: 0,
  covered_from: null,
  covered_to: null,
  group_id: null,
  error: null,
  created_at: new Date(START - 5_000),
  started_at: new Date(START),
  finished_at: null,
  rules_baseline: [evapDefrost(12)],
  rules_patched: [evapDefrost(8)],
};

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

/** Сообщение сырого топика с кадром оттайки на цикле cycle окна. */
const messageOf = (offset: number, cycle: number): KafkaMessage => {
  const atMs = FROM_MS + cycle * CYCLE_MS;
  const frame: TelemetryRaw = {
    schema: 'telemetry.raw',
    v: 1,
    ts: new Date(atMs).toISOString(),
    siteCode: 'SITE-A',
    gatewayCode: 'GW-01',
    lineCode: 'L1',
    deviceCode: 'RC-101',
    slaveId: 1,
    profileKey: rc2000Profile.profileKey,
    profileVersion: rc2000Profile.version,
    blocks: defrostBlocks(10),
    cycleMs: 40,
    traceId: atMs.toString(16).padStart(16, '0'),
  };
  return {
    key: Buffer.from('RC-101'),
    value: Buffer.from(JSON.stringify(frame)),
    headers: {},
    offset: String(offset),
    timestamp: String(atMs),
    attributes: 0,
    size: 0,
  } as unknown as KafkaMessage;
};

interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface DbScript {
  readonly stale?: number;
  readonly progress?: readonly number[];
  readonly finish?: number;
  readonly failOn?: string;
}

interface FakeDb {
  readonly pool: pg.Pool;
  readonly statements: Statement[];
  readonly released: boolean[];
}

const kindOf = (sql: string): string => {
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return sql;
  if (sql.includes('heartbeat_at IS NULL')) return 'stale';
  if (sql.includes(`SET status = 'running'`)) return 'claim';
  if (sql.includes(`status IN ('queued', 'running')`)) return 'active';
  if (sql.includes('SET offsets_total')) return 'progress';
  if (sql.includes(`SET status = 'done'`)) return 'finish';
  if (sql.includes(`SET status = 'failed', error = $2`)) return 'fail';
  if (sql.includes('INSERT INTO core.replay_alarm_episode')) return 'episodes';
  if (sql.includes('DELETE FROM core.replay_run')) return 'prune';
  return sql;
};

/** База, которая отвечает по виду запроса и запоминает всё, что ей прислали. */
const fakeDb = (script: DbScript = {}): FakeDb => {
  const statements: Statement[] = [];
  const released: boolean[] = [];
  const progress = [...(script.progress ?? [])];
  const client = {
    query: (sql: string, params: readonly unknown[] = []) => {
      statements.push({ sql, params });
      const kind = kindOf(sql);
      if (kind === script.failOn) return Promise.reject(new Error('база не приняла запрос'));
      if (kind === 'stale') return Promise.resolve({ rows: [], rowCount: script.stale ?? 0 });
      if (kind === 'claim' || kind === 'active') {
        return Promise.resolve({ rows: [RUN_ROW], rowCount: 1 });
      }
      if (kind === 'progress')
        return Promise.resolve({ rows: [], rowCount: progress.shift() ?? 1 });
      if (kind === 'finish') return Promise.resolve({ rows: [], rowCount: script.finish ?? 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release: (broken?: boolean) => {
      released.push(broken === true);
    },
  };

  return {
    pool: { connect: () => Promise.resolve(client) } as unknown as pg.Pool,
    statements,
    released,
  };
};

const kinds = (db: FakeDb): string[] => db.statements.map(({ sql }) => kindOf(sql));

const paramsOf = (db: FakeDb, kind: string): readonly unknown[] | undefined =>
  db.statements.find(({ sql }) => kindOf(sql) === kind)?.params;

interface Delivery {
  readonly partition: number;
  readonly messages: readonly KafkaMessage[];
}

interface KafkaCalls {
  readonly connects: string[];
  readonly timestamps: number[];
  readonly groups: string[];
  readonly subscribed: unknown[];
  readonly runs: unknown[];
  readonly seeks: unknown[];
  readonly pauses: unknown[];
  readonly batchPauses: number[];
  readonly resolved: string[];
  readonly deleted: string[][];
  readonly released: string[];
}

interface FakeKafka {
  readonly producer: ProducerService;
  readonly calls: KafkaCalls;
}

type BatchHandler = (payload: EachBatchPayload) => Promise<void>;

type Emit = (name: string, event: unknown) => void;

interface BrokerScript {
  readonly connect?: () => Promise<void>;
  readonly groups?: readonly string[];
}

/**
 * Брокер: смещения окна заданы тестом, пачки приходят сразу после вступления в группу. onRun
 * может послать событие потребителя или задержать запуск, пока тест его не отпустит.
 */
const fakeKafka = (
  offsets: OffsetsByTime,
  deliveries: readonly Delivery[] = [],
  onRun: (emit: Emit) => void | Promise<void> = () => undefined,
  script: BrokerScript = {},
): FakeKafka => {
  const calls: KafkaCalls = {
    connects: [],
    timestamps: [],
    groups: [],
    subscribed: [],
    runs: [],
    seeks: [],
    pauses: [],
    batchPauses: [],
    resolved: [],
    deleted: [],
    released: [],
  };

  const payloadOf = (delivery: Delivery): EachBatchPayload =>
    ({
      batch: { topic: RAW, partition: delivery.partition, messages: delivery.messages },
      resolveOffset: (offset: string) => {
        calls.resolved.push(offset);
      },
      heartbeat: () => Promise.resolve(),
      pause: () => {
        calls.batchPauses.push(delivery.partition);
        return () => undefined;
      },
      isRunning: () => true,
      isStale: () => false,
    }) as unknown as EachBatchPayload;

  const admin = {
    connect: () => {
      calls.connects.push('admin');
      return script.connect?.() ?? Promise.resolve();
    },
    disconnect: () => {
      calls.released.push('admin');
      return Promise.resolve();
    },
    fetchTopicOffsetsByTimestamp: (_topic: string, timestamp = 0) => {
      calls.timestamps.push(timestamp);
      return Promise.resolve(timestamp === FROM_MS ? offsets.starts : offsets.ends);
    },
    fetchTopicOffsets: () =>
      Promise.resolve(offsets.bounds.map((bounds) => ({ ...bounds, offset: bounds.high }))),
    listGroups: () =>
      Promise.resolve({
        groups: (script.groups ?? []).map((groupId) => ({ groupId, protocolType: 'consumer' })),
      }),
    deleteGroups: (groupIds: string[]) => {
      calls.deleted.push(groupIds);
      return Promise.resolve([]);
    },
  };

  const consumer = (config: { groupId: string }) => {
    calls.groups.push(config.groupId);
    const listeners = new Map<string, (event: unknown) => void>();
    return {
      events: { GROUP_JOIN: 'consumer.group_join', CRASH: 'consumer.crash' },
      on: (name: string, listener: (event: unknown) => void) => {
        listeners.set(name, listener);
      },
      connect: () => Promise.resolve(),
      subscribe: (options: unknown) => {
        calls.subscribed.push(options);
        return Promise.resolve();
      },
      seek: (entry: unknown) => {
        calls.seeks.push(entry);
      },
      pause: (entries: unknown) => {
        calls.pauses.push(entries);
      },
      run: async (options: {
        autoCommit: boolean;
        eachBatchAutoResolve: boolean;
        eachBatch: BatchHandler;
      }) => {
        calls.runs.push({
          autoCommit: options.autoCommit,
          eachBatchAutoResolve: options.eachBatchAutoResolve,
        });
        listeners.get('consumer.group_join')?.({
          payload: { memberAssignment: { [RAW]: offsets.bounds.map((item) => item.partition) } },
        });
        await onRun((name, event) => {
          listeners.get(name)?.(event);
        });
        for (const delivery of deliveries) await options.eachBatch(payloadOf(delivery));
      },
      stop: () => {
        calls.released.push('stop');
        return Promise.resolve();
      },
      disconnect: () => {
        calls.released.push('disconnect');
        return Promise.resolve();
      },
    };
  };

  return {
    producer: {
      isConnected: () => true,
      kafka: { admin: () => admin, consumer },
    } as unknown as ProducerService,
    calls,
  };
};

/** Окно из шести смещений в партиции 0 и пустая партиция 1. */
const WINDOW: OffsetsByTime = {
  starts: [
    { partition: 0, offset: '10' },
    { partition: 1, offset: '5' },
  ],
  ends: [
    { partition: 0, offset: '16' },
    { partition: 1, offset: '5' },
  ],
  bounds: [
    { partition: 0, low: '0', high: '20' },
    { partition: 1, low: '0', high: '5' },
  ],
};

/** Шесть кадров оттайки окна и живой кадр за его концом. */
const WINDOW_BATCH: Delivery = {
  partition: 0,
  messages: [0, 1, 2, 3, 4, 5]
    .map((cycle) => messageOf(10 + cycle, cycle))
    .concat(messageOf(16, 6)),
};

const EMPTY: OffsetsByTime = {
  starts: [{ partition: 0, offset: '20' }],
  ends: [{ partition: 0, offset: '20' }],
  bounds: [{ partition: 0, low: '0', high: '20' }],
};

const service = (
  db: FakeDb,
  kafka: FakeKafka,
  options: { clock?: FakeClock; env?: Env } = {},
): ReplayRunnerService =>
  new ReplayRunnerService(
    options.env ?? env(),
    createLogger('stream-processor', 'silent'),
    options.clock ?? createFakeClock(START),
    db.pool,
    createMetrics(),
    INSTANCE,
    kafka.producer,
    REFS_SERVICE,
  );

describe('исполнитель перепрогона', () => {
  it('окно читается временной группой, итог пишется одной транзакцией, группа удаляется', async () => {
    const db = fakeDb();
    const kafka = fakeKafka(WINDOW, [WINDOW_BATCH]);

    await expect(service(db, kafka).tick()).resolves.toBe(true);

    expect(kinds(db)).toEqual([
      'BEGIN',
      'stale',
      'COMMIT',
      'BEGIN',
      'claim',
      'COMMIT',
      'BEGIN',
      'progress',
      'COMMIT',
      'BEGIN',
      'finish',
      'episodes',
      'prune',
      'COMMIT',
    ]);
    expect(paramsOf(db, 'stale')).toEqual([
      STALE_REPLAY_ERROR,
      '2026-09-11T10:00:00.000Z',
      '2026-09-11T09:59:59.000Z',
    ]);
    expect(paramsOf(db, 'progress')?.slice(1, 8)).toEqual([6, 0, 0, 0, null, null, GROUP_ID]);
    expect(paramsOf(db, 'finish')).toEqual([
      RUN_ID,
      6,
      6,
      6,
      0,
      new Date(FROM_MS).toISOString(),
      new Date(FROM_MS + 5 * CYCLE_MS).toISOString(),
      '2026-09-11T10:00:00.000Z',
      INSTANCE,
    ]);
    expect(paramsOf(db, 'episodes')?.slice(1, 5)).toEqual([
      INSTANCE,
      ['patched'],
      [1],
      ['evap_temp_c'],
    ]);
    expect(paramsOf(db, 'prune')).toEqual([20]);
    expect(db.released.every((broken) => !broken)).toBe(true);

    expect(kafka.calls.timestamps).toEqual([FROM_MS, START + REPLAY_END_SLACK_MS]);
    expect(kafka.calls.groups).toEqual([GROUP_ID]);
    expect(kafka.calls.subscribed).toEqual([{ topics: [RAW], fromBeginning: true }]);
    expect(kafka.calls.runs).toEqual([{ autoCommit: false, eachBatchAutoResolve: false }]);
    expect(kafka.calls.seeks).toEqual([{ topic: RAW, partition: 0, offset: '10' }]);
    expect(kafka.calls.pauses).toEqual([[{ topic: RAW, partitions: [1] }]]);
    expect(kafka.calls.resolved).toEqual(['10', '11', '12', '13', '14', '15']);
    expect(kafka.calls.batchPauses).toEqual([0]);
    expect(kafka.calls.deleted).toEqual([[GROUP_ID]]);
    expect(kafka.calls.released).toEqual(['stop', 'disconnect', 'admin']);
  });

  it('пустое окно сразу завершается без временной группы', async () => {
    const db = fakeDb();
    const kafka = fakeKafka(EMPTY);

    await expect(service(db, kafka).tick()).resolves.toBe(true);

    expect(kinds(db).slice(6)).toEqual(['BEGIN', 'finish', 'prune', 'COMMIT']);
    expect(paramsOf(db, 'finish')?.slice(1, 7)).toEqual([0, 0, 0, 0, null, null]);
    expect(kafka.calls.groups).toEqual([]);
    expect(kafka.calls.deleted).toEqual([]);
    expect(kafka.calls.released).toEqual(['admin']);
  });

  it('отобранный прогон останавливается без записи итога, группа всё равно удаляется', async () => {
    const db = fakeDb({ progress: [1, 0] });
    const kafka = fakeKafka(WINDOW);

    await expect(service(db, kafka).tick()).resolves.toBe(true);

    expect(kinds(db).slice(6)).toEqual([
      'BEGIN',
      'progress',
      'COMMIT',
      'BEGIN',
      'progress',
      'COMMIT',
    ]);
    expect(kafka.calls.deleted).toEqual([[GROUP_ID]]);
    expect(kafka.calls.released).toEqual(['stop', 'disconnect', 'admin']);
  });

  it('предел времени завершает прогон с понятной ошибкой', async () => {
    const db = fakeDb();
    const clock = createFakeClock(START);
    const kafka = fakeKafka(WINDOW, [], () => {
      clock.advance(60_000);
    });

    await expect(service(db, kafka, { clock }).tick()).resolves.toBe(true);

    expect(kinds(db).slice(6)).toEqual(['BEGIN', 'progress', 'COMMIT', 'BEGIN', 'fail', 'COMMIT']);
    const [id, error, , owner] = paramsOf(db, 'fail') ?? [];
    expect([id, owner]).toEqual([RUN_ID, INSTANCE]);
    expect(error).toMatch(/не уложился в 1 мин: прочитано 0 из 6 смещений/);
    expect(kafka.calls.deleted).toEqual([[GROUP_ID]]);
  });

  it('сбой итога откатывается, а прогон завершается с ошибкой на чистом соединении', async () => {
    const db = fakeDb({ failOn: 'prune' });
    const kafka = fakeKafka(WINDOW, [WINDOW_BATCH]);

    await expect(service(db, kafka).tick()).resolves.toBe(true);

    expect(kinds(db).slice(9)).toEqual([
      'BEGIN',
      'finish',
      'episodes',
      'prune',
      'ROLLBACK',
      'BEGIN',
      'fail',
      'COMMIT',
    ]);
    expect(paramsOf(db, 'fail')?.[1]).toBe('база не приняла запрос');
    expect(db.released).toEqual([false, false, false, true, false]);
    expect(kafka.calls.deleted).toEqual([[GROUP_ID]]);
  });

  it('итог прогона, который уже не наш, откатывается без эпизодов и без провала', async () => {
    const db = fakeDb({ finish: 0 });
    const kafka = fakeKafka(WINDOW, [WINDOW_BATCH]);

    await expect(service(db, kafka).tick()).resolves.toBe(true);

    expect(kinds(db).slice(9)).toEqual(['BEGIN', 'finish', 'ROLLBACK']);
  });

  it('остановка процессора прерывает прогон и честно завершает его с ошибкой', async () => {
    const db = fakeDb();
    const kafka = fakeKafka(WINDOW);
    const runner = service(db, kafka, {
      env: env({ REPLAY_HEARTBEAT_MS: '5000', REPLAY_STALE_MS: '60000' }),
    });

    const running = runner.tick();
    await vi.waitFor(() => {
      expect(kafka.calls.runs).toHaveLength(1);
    });
    await runner.beforeApplicationShutdown();

    await expect(running).resolves.toBe(true);
    expect(kinds(db).slice(-3)).toEqual(['BEGIN', 'fail', 'COMMIT']);
    expect(paramsOf(db, 'fail')?.[1]).toBe(SHUTDOWN_REPLAY_ERROR);
    expect(kafka.calls.deleted).toEqual([[GROUP_ID]]);
    await expect(runner.tick()).resolves.toBe(false);
  });

  it('дыра в смещениях окна пропускается: партиция закрывается, потеря видна по покрытию', async () => {
    const db = fakeDb();
    const kafka = fakeKafka(WINDOW, [
      { partition: 0, messages: [3, 4, 5].map((cycle) => messageOf(10 + cycle, cycle)) },
    ]);

    await expect(service(db, kafka).tick()).resolves.toBe(true);

    expect(paramsOf(db, 'finish')?.slice(1, 7)).toEqual([
      6,
      6,
      3,
      0,
      new Date(FROM_MS + 3 * CYCLE_MS).toISOString(),
      new Date(FROM_MS + 5 * CYCLE_MS).toISOString(),
    ]);
    expect(kafka.calls.resolved).toEqual(['13', '14', '15']);
    expect(kafka.calls.batchPauses).toEqual([0]);
  });

  it('копия повторной подачи из очереди недоставленных не учитывается второй раз', async () => {
    const db = fakeDb();
    const copy: KafkaMessage = Object.assign(messageOf(16, 2), {
      headers: { [KAFKA_HEADERS.dlqAttempt]: Buffer.from('1') },
    });
    const kafka = fakeKafka(
      {
        ...WINDOW,
        ends: [
          { partition: 0, offset: '17' },
          { partition: 1, offset: '5' },
        ],
      },
      [{ partition: 0, messages: [...WINDOW_BATCH.messages.slice(0, 6), copy] }],
    );

    await expect(service(db, kafka).tick()).resolves.toBe(true);

    expect(paramsOf(db, 'finish')?.slice(1, 5)).toEqual([7, 7, 6, 0]);
    expect(kafka.calls.resolved).toHaveLength(7);
  });

  it('сбой потребителя проваливает прогон и отменяет перезапуск kafkajs', async () => {
    const db = fakeDb();
    const kafka = fakeKafka(WINDOW, [], (emit) => {
      emit('consumer.crash', { payload: { error: new Error('брокер недоступен'), restart: true } });
    });

    await expect(service(db, kafka).tick()).resolves.toBe(true);

    expect(paramsOf(db, 'fail')?.[1]).toBe(
      'потребитель перепрогона остановился: брокер недоступен',
    );
    expect(kafka.calls.released).toEqual(['stop', 'stop', 'disconnect', 'admin']);
    expect(kafka.calls.deleted).toEqual([[GROUP_ID]]);
  });

  it('остановка во время подключения к брокеру пишет провал сразу, не дожидаясь брокера', async () => {
    const db = fakeDb();
    let connected: () => void = () => undefined;
    const connecting = new Promise<void>((resolve) => {
      connected = resolve;
    });
    const kafka = fakeKafka(WINDOW, [], undefined, { connect: () => connecting });
    const runner = service(db, kafka);

    const running = runner.tick();
    await vi.waitFor(() => {
      expect(kafka.calls.connects).toHaveLength(1);
    });
    const stopping = runner.beforeApplicationShutdown();
    await vi.waitFor(() => {
      expect(kinds(db)).toContain('fail');
    });
    expect(paramsOf(db, 'fail')?.[1]).toBe(SHUTDOWN_REPLAY_ERROR);

    connected();
    await stopping;
    await expect(running).resolves.toBe(true);
    expect(kinds(db).filter((kind) => kind === 'fail')).toHaveLength(1);
    expect(kafka.calls.groups).toEqual([]);
  });

  it('вступление в группу идёт под пульсом', async () => {
    const db = fakeDb();
    let joined: () => void = () => undefined;
    const joining = new Promise<void>((resolve) => {
      joined = resolve;
    });
    const kafka = fakeKafka(WINDOW, [WINDOW_BATCH], () => joining);

    const running = service(db, kafka).tick();
    await vi.waitFor(() => {
      expect(kinds(db).filter((kind) => kind === 'progress').length).toBeGreaterThanOrEqual(3);
    });
    joined();

    await expect(running).resolves.toBe(true);
    expect(kinds(db)).toContain('finish');
    expect(kinds(db)).not.toContain('fail');
  });

  it('после брошенных прогонов их временные группы удаляются, боевая и активная остаются', async () => {
    const db = fakeDb({ stale: 1 });
    const orphan = replayGroupIdOf('0b7e5d2c-1a3f-4e6d-9c8b-7a6f5e4d3c2b');
    const kafka = fakeKafka(EMPTY, [], undefined, { groups: [INGEST_GROUP, orphan, GROUP_ID] });

    await expect(service(db, kafka).tick()).resolves.toBe(true);

    expect(kinds(db).slice(0, 6)).toEqual([
      'BEGIN',
      'stale',
      'COMMIT',
      'BEGIN',
      'active',
      'COMMIT',
    ]);
    expect(kafka.calls.deleted).toEqual([[orphan]]);
  });

  it('выключенный перепрогон не трогает ни базу, ни брокер', async () => {
    const db = fakeDb();
    const kafka = fakeKafka(WINDOW);

    await expect(service(db, kafka, { env: env({ REPLAY: 'off' }) }).tick()).resolves.toBe(false);

    expect(db.statements).toEqual([]);
    expect(kafka.calls.groups).toEqual([]);
  });
});
