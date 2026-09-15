import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REPLAY_RETENTION_MS,
  replayDiffSchema,
  replayEpisodesResponseSchema,
  replayRulesSnapshotSchema,
  replayRunSchema,
  replayRunsResponseSchema,
} from '@fieldstream/contracts';
import type {
  AlarmRule,
  DeviceMode,
  ReplayRun,
  ReplayRunsResponse,
  ReplayVariant,
  SessionResponse,
} from '@fieldstream/contracts';
import { DEFAULT_ALARM_RULES, DEMO_STAND, DEVICE_PROFILES } from '@fieldstream/device-profiles';
import {
  ROLES,
  bootstrapDatabase,
  claimReplayRun,
  connectionUrl,
  failReplayRun,
  finishReplayRun,
  insertAlarmEvents,
  insertReplayEpisodes,
  runMigrations,
  seedDemoUsers,
  syncAlarmRules,
  syncTopology,
} from '@fieldstream/db';
import type { AlarmEventRow, ReplayEpisodeRow } from '@fieldstream/db';
import {
  SystemClock,
  alarmDedupeKey,
  alarmIdOf,
  createFakeClock,
  toIsoTimestamp,
} from '@fieldstream/domain';
import { createLogger } from '@fieldstream/nest-common';
import { createApp } from '../../src/bootstrap.js';
import { loadEnv } from '../../src/config/env.js';
import { createMetrics } from '../../src/metrics/metrics.js';
import { DeviceRefsService } from '../../src/topology/device-refs.service.js';

const IMAGE = 'timescale/timescaledb-ha:pg16.6-ts2.17.2';
/** Планировщик TimescaleDB выключен: политики просыпаются посреди теста, а агрегаты тесты обновляют сами. */
const NO_BACKGROUND_JOBS = ['postgres', '-c', 'timescaledb.max_background_workers=0'];
const SUPERUSER = { user: 'postgres', password: 'superuser-pw' };
const PASSWORDS = { migrator: 'migrator-pw', ingest: 'ingest-pw', api: 'api-pw' };
const SECRET = 'секрет стенда длиной не меньше тридцати двух символов';
const PASSWORD = 'пароль стенда';
const ENGINEER = 'engineer@fieldstream.local';
const VIEWER = 'viewer@fieldstream.local';
const PROCESSOR = { instanceId: 'processor-a' };
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const EXAMPLE = { metricKey: 'evap_temp_c', mode: 'defrost', maxValue: 8 } as const;
const EPISODES_QUERY = 'deviceCode=RC-101&metricKey=evap_temp_c&mode=defrost';
const QUEUE_EXPIRED =
  'ни один процессор не забрал прогон: перепрогон выключен или процессор не запущен';
const PROGRESS = { offsetsTotal: 120, offsetsDone: 120, framesMatched: 80, framesRejected: 1 };
const NO_PROGRESS = { offsetsTotal: 0, offsetsDone: 0, framesMatched: 0, framesRejected: 0 };

const clock = createFakeClock(SystemClock.now());

let container: StartedPostgreSqlContainer;
let app: NestFastifyApplication;
let pool: pg.Pool;
let owner: pg.Client;
let ingest: pg.Client;
let base: string;
let engineer: string;
let viewer: string;
let deviceIds: ReadonlyMap<string, number>;

const login = async (email: string): Promise<string> => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });

  return ((await response.json()) as SessionResponse).accessToken;
};

const call = async (
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });

  return { status: response.status, json: await response.json().catch(() => null) };
};

/** Запрос перепрогона за последний час по двум камерам с примером правки. */
const requestOf = (fields: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  from: toIsoTimestamp(clock.now() - HOUR_MS),
  to: toIsoTimestamp(clock.now()),
  deviceCodes: ['RC-101', 'RC-102'],
  patches: [EXAMPLE],
  ...fields,
});

const startRun = async (body: unknown = requestOf()): Promise<ReplayRun> => {
  const { status, json } = await call(engineer, 'POST', '/api/replay-runs', body);
  expect(status).toBe(202);
  return replayRunSchema.parse(json);
};

const readRun = async (id: string): Promise<ReplayRun> => {
  const { status, json } = await call(viewer, 'GET', `/api/replay-runs/${id}`);
  expect(status).toBe(200);
  return replayRunSchema.parse(json);
};

const readList = async () => {
  const { status, json } = await call(viewer, 'GET', '/api/replay-runs');
  expect(status).toBe(200);
  return replayRunsResponseSchema.parse(json);
};

const countRuns = async (): Promise<number> => {
  const result = await owner.query<{ n: string }>('SELECT count(*) AS n FROM core.replay_run');
  return Number(result.rows[0]?.n);
};

/** Прогон словно поставлен давно: ни один процессор его так и не забрал. */
const ageQueuedRun = async (id: string): Promise<void> => {
  await owner.query(
    `UPDATE core.replay_run SET created_at = created_at - interval '5 minutes' WHERE id = $1`,
    [id],
  );
};

const idOf = (code: string): number => {
  const id = deviceIds.get(code);
  if (id === undefined) throw new Error(`нет прибора ${code}`);
  return id;
};

/** Живой эпизод аларма, поднятый процессором в момент atMs. */
const liveAlarm = (
  deviceCode: string,
  metricKey: string,
  mode: DeviceMode,
  atMs: number,
): AlarmEventRow => {
  const dedupeKey = alarmDedupeKey({ deviceCode, metricKey, mode, raisedAt: atMs });

  return {
    alarmId: alarmIdOf(dedupeKey),
    deviceId: idOf(deviceCode),
    metricKey,
    mode,
    severity: 'info',
    boundary: 'max',
    value: 10,
    threshold: 12,
    occurredAt: toIsoTimestamp(atMs),
    dedupeKey,
  };
};

/** Эпизод варианта перепрогона: без clearedAtMs остаётся открытым. */
const episode = (
  variant: ReplayVariant,
  deviceCode: string,
  metricKey: string,
  mode: DeviceMode,
  raisedAtMs: number,
  clearedAtMs: number | null,
): ReplayEpisodeRow => ({
  variant,
  deviceId: idOf(deviceCode),
  metricKey,
  mode,
  severity: 'info',
  boundary: 'max',
  value: 10,
  threshold: variant === 'patched' ? 8 : 12,
  raisedAt: toIsoTimestamp(raisedAtMs),
  clearedAt: clearedAtMs === null ? null : toIsoTimestamp(clearedAtMs),
  clearedValue: clearedAtMs === null ? null : 7,
});

/** Процессор забирает прогон ролью fs_ingest. */
const claimAsProcessor = async (run: ReplayRun): Promise<void> => {
  const claimed = await claimReplayRun(ingest, {
    ...PROCESSOR,
    heartbeatAt: toIsoTimestamp(clock.now()),
  });
  expect(claimed?.run.id).toBe(run.id);
};

/** Процессор завершает прогон: итог первым, затем эпизоды. */
const finishAsProcessor = async (
  run: ReplayRun,
  coverage: { readonly from: number; readonly to: number } | null,
  episodes: readonly ReplayEpisodeRow[],
): Promise<void> => {
  const finished = await finishReplayRun(ingest, run.id, PROCESSOR, {
    progress: coverage === null ? NO_PROGRESS : PROGRESS,
    coveredFrom: coverage === null ? null : toIsoTimestamp(coverage.from),
    coveredTo: coverage === null ? null : toIsoTimestamp(coverage.to),
    finishedAt: toIsoTimestamp(clock.now()),
  });
  expect(finished).toBe(true);
  expect(await insertReplayEpisodes(ingest, run.id, PROCESSOR, episodes)).toBe(episodes.length);
};

beforeAll(async () => {
  container = await new PostgreSqlContainer(IMAGE)
    .withDatabase('fieldstream')
    .withUsername(SUPERUSER.user)
    .withPassword(SUPERUSER.password)
    .withCommand(NO_BACKGROUND_JOBS)
    .start();
  const target = { host: container.getHost(), port: container.getPort(), database: 'fieldstream' };

  const admin = new pg.Client({
    connectionString: connectionUrl(target, SUPERUSER.user, SUPERUSER.password),
  });
  await admin.connect();
  await bootstrapDatabase(admin, 'fieldstream', PASSWORDS);
  await admin.end();

  await runMigrations({
    databaseUrl: connectionUrl(target, ROLES.migrator, PASSWORDS.migrator),
    direction: 'up',
  });

  owner = new pg.Client({
    connectionString: connectionUrl(target, ROLES.migrator, PASSWORDS.migrator),
  });
  await owner.connect();
  await syncTopology(owner, DEMO_STAND, DEVICE_PROFILES);
  await syncAlarmRules(owner, DEFAULT_ALARM_RULES);
  await seedDemoUsers(owner, [
    { email: ENGINEER, displayName: 'Инженер', role: 'engineer', password: PASSWORD },
    { email: VIEWER, displayName: 'Наблюдатель', role: 'viewer', password: PASSWORD },
  ]);
  const devices = await owner.query<{ id: number; code: string }>(
    'SELECT id, code FROM core.devices',
  );
  deviceIds = new Map(devices.rows.map((row) => [row.code, row.id]));

  ingest = new pg.Client({
    connectionString: connectionUrl(target, ROLES.ingest, PASSWORDS.ingest),
  });
  await ingest.connect();

  pool = new pg.Pool({ connectionString: connectionUrl(target, ROLES.api, PASSWORDS.api), max: 4 });
  clock.set(SystemClock.now());
  app = await createApp({
    env: loadEnv({
      FS_API_PASSWORD: PASSWORDS.api,
      AUTH_SECRET: SECRET,
      SSE_BRIDGE: 'off',
      OUTBOX_RELAY: 'off',
      PIPELINE_SAMPLER: 'off',
      COLLECTOR_STATUS: 'off',
    }),
    log: createLogger('api-gateway', 'fatal'),
    clock,
    metrics: createMetrics(),
    pool,
    instanceId: 'test',
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  const refs = app.get(DeviceRefsService);
  const deadline = SystemClock.now() + 10_000;
  while (!refs.isLoaded()) {
    if (SystemClock.now() >= deadline) throw new Error('шлюз не прочитал топологию');
    await delay(50);
  }

  engineer = await login(ENGINEER);
  viewer = await login(VIEWER);
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await ingest.end();
  await owner.end();
  await container.stop();
});

describe('перепрогон через шлюз', () => {
  it('без токена перепрогон закрыт', async () => {
    expect((await fetch(`${base}/api/replay-runs`)).status).toBe(401);
  });

  it('наблюдатель видит пустой список, но запустить перепрогон не может', async () => {
    expect(await readList()).toEqual({
      serverTime: toIsoTimestamp(clock.now()),
      retentionMs: REPLAY_RETENTION_MS,
      runs: [],
      activeRun: null,
    });

    expect((await call(viewer, 'POST', '/api/replay-runs', requestOf())).status).toBe(403);
    expect(await countRuns()).toBe(0);
  });

  it('неверный запрос это 400 с понятным текстом, прогон не ставится', async () => {
    const nowMs = clock.now();
    const cases: readonly (readonly [unknown, string])[] = [
      [
        requestOf({
          from: toIsoTimestamp(nowMs - REPLAY_RETENTION_MS - HOUR_MS),
          to: toIsoTimestamp(nowMs - REPLAY_RETENTION_MS + HOUR_MS),
        }),
        'более старые сырые кадры брокер уже удалил',
      ],
      [requestOf({ to: toIsoTimestamp(nowMs + 5 * MINUTE_MS) }), 'конец окна в будущем'],
      [
        requestOf({ from: toIsoTimestamp(nowMs), to: toIsoTimestamp(nowMs - HOUR_MS) }),
        'конец окна должен быть позже начала',
      ],
      [requestOf({ deviceCodes: ['RC-101', 'RC-999'] }), 'прибора RC-999 нет на стенде'],
      [
        requestOf({ deviceCodes: ['PM-201'] }),
        'правка evap_temp_c/defrost: у выбранных приборов нет такой уставки',
      ],
      [
        requestOf({ patches: [{ metricKey: 'evap_temp_c', mode: 'defrost', minValue: 20 }] }),
        'уставка RC-101/evap_temp_c/defrost: minValue должен быть меньше maxValue',
      ],
      [
        requestOf({ patches: [{ metricKey: 'evap_temp_c', mode: 'defrost', maxValue: 12 }] }),
        'значения совпадают с текущими',
      ],
      [requestOf({ patches: [] }), 'нужна хотя бы одна правка'],
      [requestOf({ promote: true }), 'promote'],
    ];

    for (const [body, text] of cases) {
      const { status, json } = await call(engineer, 'POST', '/api/replay-runs', body);
      expect(status).toBe(400);
      expect(JSON.stringify(json)).toContain(text);
    }
    expect(await countRuns()).toBe(0);
  });

  it('инженер ставит прогон со снимком уставок, второй активный 409, прогон читается по номеру', async () => {
    const run = await startRun();
    expect(run).toMatchObject({
      status: 'queued',
      requestedBy: ENGINEER,
      deviceCodes: ['RC-101', 'RC-102'],
      patches: [EXAMPLE],
      progress: NO_PROGRESS,
      coveredFrom: null,
      coveredTo: null,
      groupId: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    });

    const stored = await owner.query<{ rules_baseline: unknown; rules_patched: unknown }>(
      'SELECT rules_baseline, rules_patched FROM core.replay_run WHERE id = $1',
      [run.id],
    );
    const baseline = replayRulesSnapshotSchema.parse(stored.rows[0]?.rules_baseline);
    const patched = replayRulesSnapshotSchema.parse(stored.rows[0]?.rules_patched);
    const evapMax = (rules: readonly AlarmRule[], deviceCode: string, mode: DeviceMode) =>
      rules.find(
        (rule) =>
          rule.deviceCode === deviceCode && rule.metricKey === 'evap_temp_c' && rule.mode === mode,
      )?.maxValue;
    expect([baseline.length, patched.length]).toEqual([14, 14]);
    expect([
      evapMax(baseline, 'RC-101', 'defrost'),
      evapMax(baseline, 'RC-102', 'defrost'),
    ]).toEqual([12, 12]);
    expect([
      evapMax(patched, 'RC-101', 'defrost'),
      evapMax(patched, 'RC-102', 'defrost'),
      evapMax(patched, 'RC-101', 'cooling'),
    ]).toEqual([8, 8, 0]);

    const second = await call(
      engineer,
      'POST',
      '/api/replay-runs',
      requestOf({ patches: [{ metricKey: 'supply_temp_c', mode: 'cooling', maxValue: 3 }] }),
    );
    expect(second.status).toBe(409);
    expect(second.json).toMatchObject({
      message:
        'перепрогон на стенде уже ждёт процессора, его запустил engineer@fieldstream.local: дождитесь итога и повторите запуск',
    });

    const list = await readList();
    expect(list.activeRun).toEqual(run);
    expect(list.runs).toEqual([run]);
    expect(await readRun(run.id)).toEqual(run);

    expect((await call(viewer, 'GET', '/api/replay-runs/не-uuid')).status).toBe(400);
    expect((await call(viewer, 'GET', '/api/replay-runs/abc/diff')).status).toBe(400);
    expect(
      (await call(viewer, 'GET', `/api/replay-runs/abc/episodes?${EPISODES_QUERY}`)).status,
    ).toBe(400);
    const missing = crypto.randomUUID();
    for (const path of ['', '/diff', `/episodes?${EPISODES_QUERY}`]) {
      expect((await call(viewer, 'GET', `/api/replay-runs/${missing}${path}`)).status).toBe(404);
    }

    for (const path of ['/diff', `/episodes?${EPISODES_QUERY}`]) {
      const queued = await call(viewer, 'GET', `/api/replay-runs/${run.id}${path}`);
      expect(queued.status).toBe(409);
      expect(queued.json).toMatchObject({
        message: 'прогон ждёт процессора: итог появится после завершения',
      });
    }
  });

  it('прогон, который не забрал ни один процессор, снимается перед постановкой нового и при чтении списка', async () => {
    const stuck = (await readList()).activeRun;
    expect(stuck?.status).toBe('queued');
    if (stuck === null) return;

    await ageQueuedRun(stuck.id);
    const toMs = clock.now();
    const next = await startRun(
      requestOf({
        from: toIsoTimestamp(toMs - 1).replace('Z', '9999Z'),
        to: toIsoTimestamp(toMs),
      }),
    );
    const expired = await readRun(stuck.id);
    expect(expired).toMatchObject({ status: 'failed', error: QUEUE_EXPIRED });
    expect(Date.parse(expired.finishedAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(expired.createdAt),
    );
    expect(next).toMatchObject({
      status: 'queued',
      from: toIsoTimestamp(toMs - 1),
      to: toIsoTimestamp(toMs),
    });

    await ageQueuedRun(next.id);
    const list = await readList();
    expect(list.activeRun).toBeNull();
    expect(list.runs.map((run) => [run.id, run.status, run.error])).toEqual([
      [next.id, 'failed', QUEUE_EXPIRED],
      [stuck.id, 'failed', QUEUE_EXPIRED],
    ]);
  });

  it('порог очереди считается по часам базы: спешащие часы шлюза свежий прогон не снимают', async () => {
    clock.set(SystemClock.now() + 5 * MINUTE_MS);
    let fresh: ReplayRun;
    let skewed: ReplayRunsResponse;
    try {
      fresh = await startRun();
      skewed = await readList();
    } finally {
      clock.set(SystemClock.now());
    }
    expect(skewed.activeRun).toEqual(fresh);

    await ageQueuedRun(fresh.id);
    expect((await readList()).activeRun).toBeNull();
    expect(await readRun(fresh.id)).toMatchObject({ status: 'failed', error: QUEUE_EXPIRED });
  });

  it('итог 409, пока прогон идёт; после завершения изменённые уставки, разница и эпизоды по покрытию', async () => {
    const run = await startRun();
    const fromMs = Date.parse(run.from);
    const coveredFrom = fromMs + 10 * MINUTE_MS;
    const coveredTo = fromMs + 50 * MINUTE_MS;

    await claimAsProcessor(run);
    const busy = await call(
      engineer,
      'POST',
      '/api/replay-runs',
      requestOf({ patches: [{ metricKey: 'supply_temp_c', mode: 'cooling', maxValue: 3 }] }),
    );
    expect(busy.status).toBe(409);
    expect(busy.json).toMatchObject({
      message:
        'перепрогон на стенде уже идёт, его запустил engineer@fieldstream.local: дождитесь итога и повторите запуск',
    });

    const running = await call(viewer, 'GET', `/api/replay-runs/${run.id}/diff`);
    expect(running.status).toBe(409);
    expect(running.json).toMatchObject({
      message: 'прогон ещё идёт: итог появится после завершения',
    });

    await insertAlarmEvents(ingest, [
      liveAlarm('RC-101', 'evap_temp_c', 'defrost', coveredFrom + 5 * MINUTE_MS),
      liveAlarm('RC-101', 'evap_temp_c', 'defrost', fromMs + 2 * MINUTE_MS),
      liveAlarm('RC-102', 'supply_temp_c', 'cooling', coveredTo),
      liveAlarm('RC-102', 'return_temp_c', 'cooling', coveredFrom + 30 * MINUTE_MS),
      liveAlarm('RC-103', 'evap_temp_c', 'defrost', coveredFrom + 5 * MINUTE_MS),
    ]);
    await finishAsProcessor(run, { from: coveredFrom, to: coveredTo }, [
      episode(
        'patched',
        'RC-101',
        'evap_temp_c',
        'defrost',
        coveredFrom + 5 * MINUTE_MS,
        coveredFrom + 8 * MINUTE_MS,
      ),
      episode('patched', 'RC-101', 'evap_temp_c', 'defrost', coveredFrom + 35 * MINUTE_MS, null),
      episode(
        'baseline',
        'RC-102',
        'supply_temp_c',
        'cooling',
        coveredFrom + 20 * MINUTE_MS,
        coveredFrom + 25 * MINUTE_MS,
      ),
      episode(
        'patched',
        'RC-102',
        'supply_temp_c',
        'cooling',
        coveredFrom + 20 * MINUTE_MS,
        coveredFrom + 25 * MINUTE_MS,
      ),
    ]);

    const { status, json } = await call(viewer, 'GET', `/api/replay-runs/${run.id}/diff`);
    expect(status).toBe(200);
    const diff = replayDiffSchema.parse(json);
    expect(diff.run).toMatchObject({
      id: run.id,
      status: 'done',
      progress: PROGRESS,
      coveredFrom: toIsoTimestamp(coveredFrom),
      coveredTo: toIsoTimestamp(coveredTo),
      error: null,
    });

    const values = {
      minValue: -28,
      maxValue: 12,
      hysteresis: 1,
      debounceCycles: 6,
      severity: 'info',
      enabled: true,
    };
    expect(diff.changedRules).toEqual(
      ['RC-101', 'RC-102'].map((deviceCode) => ({
        deviceCode,
        metricKey: 'evap_temp_c',
        mode: 'defrost',
        baseline: values,
        patched: { ...values, maxValue: 8 },
      })),
    );
    expect(diff.rows).toEqual([
      {
        deviceCode: 'RC-101',
        metricKey: 'evap_temp_c',
        mode: 'defrost',
        baseline: 0,
        patched: 2,
        added: 2,
        removed: 0,
        live: 1,
      },
      {
        deviceCode: 'RC-102',
        metricKey: 'return_temp_c',
        mode: 'cooling',
        baseline: 0,
        patched: 0,
        added: 0,
        removed: 0,
        live: 1,
      },
      {
        deviceCode: 'RC-102',
        metricKey: 'supply_temp_c',
        mode: 'cooling',
        baseline: 1,
        patched: 1,
        added: 0,
        removed: 0,
        live: 1,
      },
    ]);

    const episodes = await call(
      viewer,
      'GET',
      `/api/replay-runs/${run.id}/episodes?${EPISODES_QUERY}`,
    );
    expect(episodes.status).toBe(200);
    const evap = {
      deviceCode: 'RC-101',
      metricKey: 'evap_temp_c',
      mode: 'defrost',
      severity: 'info',
      boundary: 'max',
      value: 10,
      threshold: 8,
    };
    expect(replayEpisodesResponseSchema.parse(episodes.json)).toEqual({
      runId: run.id,
      deviceCode: 'RC-101',
      metricKey: 'evap_temp_c',
      mode: 'defrost',
      truncated: false,
      baseline: [],
      patched: [
        {
          ...evap,
          raisedAt: toIsoTimestamp(coveredFrom + 5 * MINUTE_MS),
          clearedAt: toIsoTimestamp(coveredFrom + 8 * MINUTE_MS),
          clearedValue: 7,
        },
        {
          ...evap,
          raisedAt: toIsoTimestamp(coveredFrom + 35 * MINUTE_MS),
          clearedAt: null,
          clearedValue: null,
        },
      ],
    });

    for (const query of [
      'deviceCode=RC-101&metricKey=evap_temp_c&mode=heating',
      'metricKey=evap_temp_c&mode=defrost',
      `${EPISODES_QUERY}&variant=patched`,
    ]) {
      expect(
        (await call(viewer, 'GET', `/api/replay-runs/${run.id}/episodes?${query}`)).status,
      ).toBe(400);
    }
  });

  it('прогон без покрытия живых не считает, у проваленного итога нет', async () => {
    const empty = await startRun();
    await claimAsProcessor(empty);
    await finishAsProcessor(empty, null, []);

    const { status, json } = await call(viewer, 'GET', `/api/replay-runs/${empty.id}/diff`);
    expect(status).toBe(200);
    const diff = replayDiffSchema.parse(json);
    expect(diff.run).toMatchObject({ status: 'done', coveredFrom: null, coveredTo: null });
    expect(diff.changedRules).toHaveLength(2);
    expect(diff.rows).toEqual([]);

    await owner.query(
      `UPDATE core.replay_run SET rules_patched = '[{"deviceCode":"RC-101"}]'::jsonb WHERE id = $1`,
      [empty.id],
    );
    const broken = await call(viewer, 'GET', `/api/replay-runs/${empty.id}/diff`);
    expect(broken.status).toBe(500);
    expect(broken.json).toMatchObject({
      message: 'снимок уставок прогона испорчен, подробности в журнале',
    });

    const failed = await startRun();
    await claimAsProcessor(failed);
    expect(
      await failReplayRun(ingest, failed.id, PROCESSOR, {
        error: 'процессор остановлен посреди перепрогона',
        finishedAt: toIsoTimestamp(clock.now()),
      }),
    ).toBe(true);

    for (const path of ['/diff', `/episodes?${EPISODES_QUERY}`]) {
      const reply = await call(viewer, 'GET', `/api/replay-runs/${failed.id}${path}`);
      expect(reply.status).toBe(409);
      expect(reply.json).toMatchObject({
        message: 'прогон завершён с ошибкой, итога нет: процессор остановлен посреди перепрогона',
      });
    }
  });
});
