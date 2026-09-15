import { readdir } from 'node:fs/promises';
import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_ALARM_RULES,
  DEMO_STAND,
  DEVICE_PROFILES,
  rc2000Profile,
} from '@fieldstream/device-profiles';
import { connectionUrl } from '../../src/setup/connection.js';
import type { ConnectionTarget } from '../../src/setup/connection.js';
import { MIGRATIONS_DIR, runMigrations } from '../../src/setup/migrate.js';
import { ROLES, bootstrapDatabase } from '../../src/setup/roles.js';
import {
  clearAlarmEvents,
  insertAlarmEvents,
  loadAlarmRules,
  loadOpenAlarmEpisodes,
  syncAlarmRules,
} from '../../src/store/alarms.js';
import type { AlarmEventRow } from '../../src/store/alarms.js';
import {
  claimDlqRedrive,
  enqueueDlqRedrive,
  failStaleDlqRedrives,
  listDlqMessages,
  loadDlqCounts,
  loadDlqRedrive,
  markDlqResolved,
  resolveDlqCopies,
  selectDlqForRedrive,
} from '../../src/store/dlq.js';
import {
  loadDeviceStates,
  lockDeviceStateHandover,
  recordDlqMessages,
  upsertDeviceStates,
} from '../../src/store/state.js';
import { loadDeviceRefs, syncTopology } from '../../src/store/topology.js';
import { insertPollCycles, insertReadings } from '../../src/store/writer.js';
import type { ReadingRow } from '../../src/store/writer.js';

const IMAGE = 'timescale/timescaledb-ha:pg16.6-ts2.17.2';
/** Планировщик TimescaleDB выключен: политики просыпаются посреди теста, а агрегаты тесты обновляют сами. */
const NO_BACKGROUND_JOBS = ['postgres', '-c', 'timescaledb.max_background_workers=0'];
const SUPERUSER = { user: 'postgres', password: 'superuser-pw' };
const PASSWORDS = { migrator: 'migrator-pw', ingest: 'ingest-pw', api: 'api-pw' };

let container: StartedPostgreSqlContainer;
let target: ConnectionTarget;
const clients: pg.Client[] = [];

const connect = async (user: string, password: string): Promise<pg.Client> => {
  const client = new pg.Client({ connectionString: connectionUrl(target, user, password) });
  await client.connect();
  clients.push(client);
  return client;
};

const migratorUrl = (): string => connectionUrl(target, ROLES.migrator, PASSWORDS.migrator);

/** Сколько миграций лежит в каталоге: иначе каждая новая миграция правит этот тест руками. */
const migrationCount = async (): Promise<number> =>
  (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).length;

const deviceId = async (client: pg.Client, code: string): Promise<number> => {
  const ref = (await loadDeviceRefs(client)).get(code);
  if (ref === undefined) throw new Error(`в базе нет прибора ${code}`);
  return ref.deviceId;
};

/** Момент в прошлом, выровненный по часу, по часам самой базы. */
const hoursAgo = async (client: pg.Client, hours: number): Promise<number> => {
  const result = await client.query<{ at: Date }>(
    `SELECT date_trunc('hour', now()) - make_interval(hours => $1) AS at`,
    [hours],
  );
  const at = result.rows[0]?.at;
  if (at === undefined) throw new Error('база не вернула время');
  return at.getTime();
};

beforeAll(async () => {
  container = await new PostgreSqlContainer(IMAGE)
    .withDatabase('fieldstream')
    .withUsername(SUPERUSER.user)
    .withPassword(SUPERUSER.password)
    .withCommand(NO_BACKGROUND_JOBS)
    .start();
  target = { host: container.getHost(), port: container.getPort(), database: 'fieldstream' };

  const admin = await connect(SUPERUSER.user, SUPERUSER.password);
  await bootstrapDatabase(admin, 'fieldstream', PASSWORDS);
  await runMigrations({ databaseUrl: migratorUrl(), direction: 'up' });
  await syncTopology(
    await connect(ROLES.migrator, PASSWORDS.migrator),
    DEMO_STAND,
    DEVICE_PROFILES,
  );
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.end()));
  await container.stop();
});

describe('схема базы на настоящей TimescaleDB', () => {
  it('миграции откатываются до нуля и накатываются заново', async () => {
    const owner = await connect(ROLES.migrator, PASSWORDS.migrator);
    const exists = async (name: string): Promise<boolean> =>
      (await owner.query<{ found: string | null }>('SELECT to_regclass($1) AS found', [name]))
        .rows[0]?.found != null;

    const total = await migrationCount();

    const down = await runMigrations({ databaseUrl: migratorUrl(), direction: 'down' });
    expect(down).toHaveLength(total);
    expect(await exists('ts.readings')).toBe(false);
    expect(await exists('core.devices')).toBe(false);
    expect(await exists('core.alarm_events')).toBe(false);

    const up = await runMigrations({ databaseUrl: migratorUrl(), direction: 'up' });
    expect(up).toHaveLength(total);
    expect(await exists('ts.readings_1h')).toBe(true);
    expect(await exists('core.outbox')).toBe(true);

    await syncTopology(owner, DEMO_STAND, DEVICE_PROFILES);
    expect((await loadDeviceRefs(owner)).size).toBe(24);
  });

  it('повторная синхронизация ничего не дублирует, правка профиля без новой версии отвергается', async () => {
    const owner = await connect(ROLES.migrator, PASSWORDS.migrator);
    await syncTopology(owner, DEMO_STAND, DEVICE_PROFILES);

    const devices = await owner.query<{ n: string }>('SELECT count(*) AS n FROM core.devices');
    expect(devices.rows[0]?.n).toBe('24');

    const edited = { ...rc2000Profile, label: 'Контроллер с тихо изменённым описанием' };
    await expect(syncTopology(owner, DEMO_STAND, [edited, ...DEVICE_PROFILES])).rejects.toThrow(
      'профиль rc-2000 версии 1 изменён без повышения версии',
    );
  });

  it('роль интерфейса читает агрегаты, но не может писать телеметрию', async () => {
    const api = await connect(ROLES.api, PASSWORDS.api);

    await expect(api.query('SELECT count(*) FROM ts.v_readings_1h')).resolves.toBeDefined();
    await expect(
      api.query(
        `INSERT INTO ts.readings (ts, device_id, metric_key, value) VALUES (now(), 1, 'x', 1)`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('роль интерфейса считает очередь недоставленных: неразобранные отдельно от всех', async () => {
    const api = await connect(ROLES.api, PASSWORDS.api);
    const ingest = await connect(ROLES.ingest, PASSWORDS.ingest);
    const before = await loadDlqCounts(api);

    await ingest.query(
      `INSERT INTO core.dlq_message (source_topic, partition, "offset", error, resolved_at,
         final_rejected)
       VALUES ('dlq-count', 0, 1, '{}', NULL, false), ('dlq-count', 0, 2, '{}', NULL, false),
              ('dlq-count', 0, 3, '{}', now(), false), ('dlq-count', 0, 4, '{}', NULL, true)`,
    );

    expect(await loadDlqCounts(api)).toEqual({
      unresolved: before.unresolved + 2,
      total: before.total + 4,
    });
  });

  it('очередь недоставленных листается курсором от новых к старым без пропусков и повторов', async () => {
    const api = await connect(ROLES.api, PASSWORDS.api);
    const ingest = await connect(ROLES.ingest, PASSWORDS.ingest);
    const firstSeen = '2026-09-11T10:00:00.000Z';

    await recordDlqMessages(
      ingest,
      [1, 2, 3].map((offset) => ({
        sourceTopic: 'dlq-list',
        partition: 2,
        offset: String(offset),
        key: 'RC-102',
        headers: {},
        payload: Buffer.from([0x7b, 0xff, 0x00, 0x41]),
        errorClass: 'invalid_json',
        error: 'Unexpected token',
        attempts: offset,
        firstSeen,
      })),
    );

    const first = await listDlqMessages(api, { limit: 2 });
    expect(first.items.map((item) => item.offset)).toEqual(['3', '2']);
    expect(first.items[0]).toMatchObject({
      sourceTopic: 'dlq-list',
      partition: 2,
      key: 'RC-102',
      errorClass: 'invalid_json',
      error: 'Unexpected token',
      attempts: 3,
      firstSeen,
      resolvedAt: null,
      finalRejected: false,
      payloadPreview: '{··A',
      payloadBytes: 4,
    });
    expect(first.nextCursor).toBe(first.items[1]?.id);

    const second = await listDlqMessages(api, { limit: 2, cursor: first.nextCursor ?? '' });
    expect(second.items[0]?.offset).toBe('1');
    expect(second.items[0]?.attempts).toBe(1);

    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listDlqMessages(api, { limit: 2, cursor });
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    const total = await api.query<{ n: string }>('SELECT count(*) AS n FROM core.dlq_message');
    expect(ids).toHaveLength(Number(total.rows[0]?.n));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.map(BigInt)).toEqual([...ids.map(BigInt)].sort((a, b) => (a > b ? -1 : 1)));
  });

  it('запрос повторной подачи достаётся одному экземпляру, а отобранные сообщения не двоятся', async () => {
    const api = await connect(ROLES.api, PASSWORDS.api);
    const first = await connect(ROLES.ingest, PASSWORDS.ingest);
    const second = await connect(ROLES.ingest, PASSWORDS.ingest);

    const queued = [
      await enqueueDlqRedrive(api, { requestedBy: 'engineer@fieldstream.local', maxMessages: 2 }),
      await enqueueDlqRedrive(api, { requestedBy: 'engineer@fieldstream.local', maxMessages: 2 }),
    ];
    expect(queued.map((request) => request.status)).toEqual(['queued', 'queued']);

    await first.query('BEGIN');
    const mine = await claimDlqRedrive(first);
    const theirs = await claimDlqRedrive(second);
    const candidates = await selectDlqForRedrive(first, { topics: ['dlq-list'], limit: 2 });
    await second.query('BEGIN');
    const skipped = await selectDlqForRedrive(second, { topics: ['dlq-list'], limit: 2 });
    await second.query('ROLLBACK');
    await first.query('COMMIT');

    expect(mine?.status).toBe('running');
    expect(theirs?.status).toBe('running');
    expect(mine?.id).not.toBe(theirs?.id);
    expect([mine?.id, theirs?.id].sort()).toEqual(queued.map((request) => request.id).sort());
    expect(await claimDlqRedrive(second)).toBeNull();

    expect(candidates.map((row) => row.attempts)).toEqual([1, 2]);
    expect(skipped.map((row) => row.attempts)).toEqual([3]);
    expect((await loadDlqRedrive(api, mine?.id ?? '0'))?.startedAt).not.toBeNull();
  });

  it('роль интерфейса кладёт запрос повторной подачи, но не меняет ни очередь, ни запрос', async () => {
    const api = await connect(ROLES.api, PASSWORDS.api);
    const request = await enqueueDlqRedrive(api, {
      requestedBy: 'engineer@fieldstream.local',
      maxMessages: 10,
    });

    await expect(
      api.query(`UPDATE core.dlq_message SET resolved_at = now() WHERE source_topic = 'dlq-list'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      api.query(`DELETE FROM core.dlq_message WHERE source_topic = 'dlq-list'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      api.query(`UPDATE core.dlq_redrive SET status = 'done' WHERE id = $1`, [request.id]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      api.query(
        `INSERT INTO core.dlq_redrive (requested_by, max_messages, status) VALUES ($1, 10, 'running')`,
        ['engineer@fieldstream.local'],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      api.query(
        `INSERT INTO core.dlq_redrive (requested_by, max_messages, redriven, finished_at)
         VALUES ($1, 10, 99, now())`,
        ['engineer@fieldstream.local'],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      enqueueDlqRedrive(api, { requestedBy: 'engineer@fieldstream.local', maxMessages: 501 }),
    ).rejects.toThrow(/check constraint/);
  });

  it('отметка о разборе не перетирает прежнюю и не трогает окончательно отвергнутые', async () => {
    const ingest = await connect(ROLES.ingest, PASSWORDS.ingest);
    const inserted = await ingest.query<{ id: string }>(
      `INSERT INTO core.dlq_message (source_topic, partition, "offset", error, resolved_at,
         final_rejected)
       VALUES ('dlq-resolve', 0, 1, '{}', NULL, false),
              ('dlq-resolve', 0, 2, '{}', '2026-09-11T09:00:00Z', false),
              ('dlq-resolve', 0, 3, '{}', NULL, true)
       RETURNING id`,
    );
    const ids = inserted.rows.map((row) => row.id);

    await markDlqResolved(ingest, ids, '2026-09-11T10:00:00.000Z');

    const rows = await ingest.query<{ resolved_at: Date | null }>(
      `SELECT resolved_at FROM core.dlq_message WHERE source_topic = 'dlq-resolve' ORDER BY id`,
    );
    expect(rows.rows.map((row) => row.resolved_at?.toISOString() ?? null)).toEqual([
      '2026-09-11T10:00:00.000Z',
      '2026-09-11T09:00:00.000Z',
      null,
    ]);
  });

  it('две копии одной строки очереди дают одну неудачу, повтор смещения тоже, чужой номер не пишется', async () => {
    const ingest = await connect(ROLES.ingest, PASSWORDS.ingest);
    const origins = await ingest.query<{ id: string }>(
      `INSERT INTO core.dlq_message (source_topic, partition, "offset", key, error)
       VALUES ('dlq-copies', 0, 900, 'RC-102', '{}'), ('dlq-copies', 0, 901, 'RC-102', '{}')
       RETURNING id`,
    );
    const [first = null, second = null] = origins.rows.map((origin) => origin.id);
    const row = (offset: number, redriveOf: string | null, key = 'RC-102') => ({
      sourceTopic: 'dlq-copies',
      partition: 0,
      offset: String(offset),
      key,
      headers: {},
      payload: Buffer.from('{не json'),
      errorClass: 'invalid_json',
      error: 'Unexpected token',
      attempts: 2,
      redriveOf,
    });

    await recordDlqMessages(ingest, [row(1, first), row(2, first), row(3, null), row(4, null)]);
    await recordDlqMessages(ingest, [row(3, null), row(6, second, 'RC-999'), row(5, second)]);

    const stored = await ingest.query<{ offset: string; redrive_of: string | null }>(
      `SELECT "offset", redrive_of FROM core.dlq_message
       WHERE source_topic = 'dlq-copies' AND "offset" < 900
       ORDER BY id`,
    );
    expect(stored.rows).toEqual([
      { offset: '1', redrive_of: first },
      { offset: '3', redrive_of: null },
      { offset: '4', redrive_of: null },
      { offset: '6', redrive_of: null },
      { offset: '5', redrive_of: second },
    ]);
  });

  it('копия закрывает только свою строку и не ждёт строку, которую держит подача', async () => {
    const ingest = await connect(ROLES.ingest, PASSWORDS.ingest);
    const redriving = await connect(ROLES.ingest, PASSWORDS.ingest);
    const topic = 'dlq-copy-close';
    const inserted = await ingest.query<{ id: string }>(
      `INSERT INTO core.dlq_message (source_topic, partition, "offset", key, error)
       VALUES ($1, 0, 1, 'RC-102', '{}'), ($1, 0, 2, 'RC-102', '{}'), ($1, 0, 3, NULL, '{}'),
              ($1, 0, 4, 'RC-102', '{}'), ($1, 0, 5, 'RC-102', '{}')
       RETURNING id`,
      [topic],
    );
    const ids = inserted.rows.map((row) => row.id);
    const copy = (index: number, sourceTopic: string, key: string | null) => ({
      id: ids[index] ?? '0',
      sourceTopic,
      key,
    });

    await ingest.query(`SET lock_timeout = '2s'`);
    await redriving.query('BEGIN');
    const locked = await selectDlqForRedrive(redriving, { topics: [topic], limit: 1 });
    await resolveDlqCopies(
      ingest,
      [
        copy(0, topic, 'RC-102'),
        copy(1, topic, 'RC-102'),
        copy(2, topic, null),
        copy(3, topic, 'RC-999'),
        copy(4, 'dlq-other', 'RC-102'),
      ],
      '2026-09-11T10:00:00.000Z',
    );
    await redriving.query('ROLLBACK');

    const rows = await ingest.query<{ resolved: boolean }>(
      `SELECT resolved_at IS NOT NULL AS resolved FROM core.dlq_message
       WHERE source_topic = $1 ORDER BY id`,
      [topic],
    );
    expect(locked.map((row) => row.id)).toEqual([ids[0]]);
    expect(rows.rows.map((row) => row.resolved)).toEqual([false, true, true, false, false]);
  });

  it('брошенный в работе запрос завершается с ошибкой, ждущие и забираемые сейчас не трогаются', async () => {
    const api = await connect(ROLES.api, PASSWORDS.api);
    const ingest = await connect(ROLES.ingest, PASSWORDS.ingest);
    const claiming = await connect(ROLES.ingest, PASSWORDS.ingest);
    const entry = { requestedBy: 'engineer@fieldstream.local', maxMessages: 5 };
    const stuck = await enqueueDlqRedrive(api, entry);
    const done = await enqueueDlqRedrive(api, entry);
    const waiting = await enqueueDlqRedrive(api, entry);

    await ingest.query(
      `UPDATE core.dlq_redrive SET status = 'running', started_at = now() WHERE id = $1`,
      [stuck.id],
    );
    await ingest.query(
      `UPDATE core.dlq_redrive SET status = 'done', finished_at = now() WHERE id = $1`,
      [done.id],
    );

    await claiming.query('BEGIN');
    const claimed = await claimDlqRedrive(claiming);
    const failed = await failStaleDlqRedrives(ingest, 'брошен', '2026-09-11T10:00:00.000Z');
    await claiming.query('ROLLBACK');

    expect(failed).toBeGreaterThanOrEqual(1);
    expect(await loadDlqRedrive(api, stuck.id)).toMatchObject({
      status: 'failed',
      error: 'брошен',
      finishedAt: '2026-09-11T10:00:00.000Z',
    });
    expect((await loadDlqRedrive(api, done.id))?.status).toBe('done');
    expect((await loadDlqRedrive(api, waiting.id))?.status).toBe('queued');
    expect((await loadDlqRedrive(api, claimed?.id ?? '0'))?.status).toBe('queued');
  });

  it('стартовые уставки заводятся на все приборы, а правка оператора переносом не затирается', async () => {
    const owner = await connect(ROLES.migrator, PASSWORDS.migrator);

    const added = await syncAlarmRules(owner, DEFAULT_ALARM_RULES);
    expect(added).toBeGreaterThan(0);
    expect(await syncAlarmRules(owner, DEFAULT_ALARM_RULES)).toBe(0);
    expect(await loadAlarmRules(owner)).toHaveLength(added);

    const supply = (await loadAlarmRules(owner)).filter(
      (rule) => rule.deviceCode === 'RC-101' && rule.metricKey === 'supply_temp_c',
    );
    expect(supply.map((rule) => rule.mode).sort()).toEqual(['cooling', 'defrost']);
    const cooling = supply.find((rule) => rule.mode === 'cooling');
    const defrost = supply.find((rule) => rule.mode === 'defrost');
    expect(cooling?.maxValue ?? 0).toBeLessThan(defrost?.maxValue ?? 0);

    await owner.query(
      `UPDATE core.alarm_rules SET max_value = -5, updated_by = 'engineer'
       WHERE metric_key = 'supply_temp_c' AND mode = 'cooling'
         AND device_id = (SELECT id FROM core.devices WHERE code = 'RC-101')`,
    );
    expect(await syncAlarmRules(owner, DEFAULT_ALARM_RULES)).toBe(0);

    const edited = (await loadAlarmRules(owner)).find(
      (rule) =>
        rule.deviceCode === 'RC-101' &&
        rule.metricKey === 'supply_temp_c' &&
        rule.mode === 'cooling',
    );
    expect(edited?.maxValue).toBe(-5);
  });

  it('аларм создаёт процессор, подтверждает интерфейс, и заменить друг друга они не могут', async () => {
    const owner = await connect(ROLES.migrator, PASSWORDS.migrator);
    const ingest = await connect(ROLES.ingest, PASSWORDS.ingest);
    const api = await connect(ROLES.api, PASSWORDS.api);
    await syncAlarmRules(owner, DEFAULT_ALARM_RULES);
    const id = await deviceId(ingest, 'RC-103');
    const key = 'RC-103|supply_temp_c|cooling|raised|2026-01-01T00:00:00.000Z';

    const raised = await ingest.query(
      `INSERT INTO core.alarm_events (device_id, metric_key, mode, severity, boundary, value,
         threshold, occurred_at, dedupe_key)
       VALUES ($1, 'supply_temp_c', 'cooling', 'warning', 'max', 4.5, 2, now(), $2)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [id, key],
    );
    expect(raised.rowCount).toBe(1);

    await expect(
      api.query(
        `INSERT INTO core.alarm_events (device_id, metric_key, mode, severity, boundary,
           occurred_at, dedupe_key)
         VALUES ($1, 'supply_temp_c', 'cooling', 'info', 'max', now(), 'ключ от интерфейса')`,
        [id],
      ),
    ).rejects.toThrow(/permission denied/);

    const acked = await api.query(
      `UPDATE core.alarm_events SET acked_by = 'engineer', acked_at = now() WHERE dedupe_key = $1`,
      [key],
    );
    expect(acked.rowCount).toBe(1);

    await expect(
      api.query('UPDATE core.alarm_events SET value = 0 WHERE dedupe_key = $1', [key]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      ingest.query('UPDATE core.alarm_rules SET max_value = 0 WHERE device_id = $1', [id]),
    ).rejects.toThrow(/permission denied/);
  });

  it('последнее состояние читается только по перечисленным приборам', async () => {
    const ingest = await connect(ROLES.ingest, PASSWORDS.ingest);
    const updatedAt = new Date(await hoursAgo(ingest, 0)).toISOString();
    const online = {
      schema: 'device.state',
      v: 1,
      deviceCode: 'RC-110',
      status: 'online',
      reason: 'ok',
      since: '2026-09-11T10:00:00.000Z',
      mode: 'defrost',
      lastOkAt: '2026-09-11T10:04:30.000Z',
      consecutiveErrors: 1,
    } as const;
    const offline = {
      ...online,
      deviceCode: 'RC-111',
      status: 'offline',
      reason: 'consecutive_errors',
      mode: 'cooling',
      lastOkAt: null,
      consecutiveErrors: 5,
    } as const;

    await upsertDeviceStates(ingest, [
      { deviceId: await deviceId(ingest, 'RC-110'), state: online, updatedAt },
      { deviceId: await deviceId(ingest, 'RC-111'), state: offline, updatedAt },
    ]);

    expect(await loadDeviceStates(ingest, ['RC-111', 'RC-110', 'RC-999'])).toEqual([
      online,
      offline,
    ]);
    expect(await loadDeviceStates(ingest, ['RC-111'])).toEqual([offline]);
    expect(await loadDeviceStates(ingest, ['PM-212'])).toEqual([]);
  });

  it('новый владелец не читает состояние, пока прежний дописывает проверку здоровья', async () => {
    const publisher = await connect(ROLES.ingest, PASSWORDS.ingest);
    const neighbour = await connect(ROLES.ingest, PASSWORDS.ingest);
    const adopter = await connect(ROLES.ingest, PASSWORDS.ingest);

    await publisher.query('BEGIN');
    await lockDeviceStateHandover(publisher, 'publish');

    await neighbour.query('BEGIN');
    await lockDeviceStateHandover(neighbour, 'publish', 200);
    await neighbour.query('COMMIT');

    await adopter.query('BEGIN');
    await expect(lockDeviceStateHandover(adopter, 'adopt', 200)).rejects.toThrow(/lock timeout/);
    await adopter.query('ROLLBACK');

    await publisher.query('COMMIT');
    await adopter.query('BEGIN');
    await lockDeviceStateHandover(adopter, 'adopt', 200);
    await adopter.query('COMMIT');
  });

  it('открытые эпизоды фильтруются по приборам, закрытые не попадают вовсе', async () => {
    const ingest = await connect(ROLES.ingest, PASSWORDS.ingest);
    const base = await hoursAgo(ingest, 2);
    const episode = async (deviceCode: string, offsetMs: number): Promise<AlarmEventRow> => {
      const occurredAt = new Date(base + offsetMs).toISOString();
      return {
        alarmId: crypto.randomUUID(),
        deviceId: await deviceId(ingest, deviceCode),
        metricKey: 'supply_temp_c',
        mode: 'cooling',
        severity: 'critical',
        boundary: 'max',
        value: 7.5,
        threshold: 2,
        occurredAt,
        dedupeKey: `${deviceCode}|supply_temp_c|cooling|raised|${occurredAt}`,
      };
    };
    const rows = [
      await episode('RC-106', 0),
      await episode('RC-107', 1_000),
      await episode('RC-108', 2_000),
    ];
    await insertAlarmEvents(ingest, rows);
    await clearAlarmEvents(ingest, [
      {
        dedupeKey: rows[1]?.dedupeKey ?? '',
        clearedAt: new Date(base + 60_000).toISOString(),
        clearedValue: 1,
      },
    ]);

    const filtered = await loadOpenAlarmEpisodes(ingest, ['RC-106', 'RC-107']);
    expect(filtered).toEqual([
      {
        deviceCode: 'RC-106',
        metricKey: 'supply_temp_c',
        mode: 'cooling',
        boundary: 'max',
        severity: 'critical',
        threshold: 2,
        raisedAtMs: base,
      },
    ]);
    expect(await loadOpenAlarmEpisodes(ingest, [])).toEqual([]);

    const everyone = (await loadOpenAlarmEpisodes(ingest)).map((item) => item.deviceCode);
    expect(everyone).toContain('RC-106');
    expect(everyone).toContain('RC-108');
    expect(everyone).not.toContain('RC-107');
  });

  it('команду в очередь кладёт интерфейс, а факт применения пишет процессор', async () => {
    const api = await connect(ROLES.api, PASSWORDS.api);
    const ingest = await connect(ROLES.ingest, PASSWORDS.ingest);

    const queued = await api.query(
      `INSERT INTO core.outbox (aggregate_type, aggregate_id, revision, topic, msg_key, payload)
       VALUES ('command', 'CMD-1', 1, 'fieldstream.device.commands.v1', 'SITE-A',
               '{"kind":"line.enable"}')`,
    );
    expect(queued.rowCount).toBe(1);
    await expect(
      api.query(
        `INSERT INTO core.outbox (aggregate_type, aggregate_id, revision, topic, msg_key, payload)
         VALUES ('command', 'CMD-1', 1, 'fieldstream.device.commands.v1', 'SITE-A', '{}')`,
      ),
    ).rejects.toThrow(/duplicate key/);

    const applied = await ingest.query(
      `INSERT INTO core.applied_commands (command_id, line_id, kind, applied_at)
       SELECT gen_random_uuid(), id, 'line.enable', now() FROM core.lines ORDER BY id LIMIT 1`,
    );
    expect(applied.rowCount).toBe(1);
    await expect(
      api.query(
        `INSERT INTO core.applied_commands (command_id, line_id, kind, applied_at)
         SELECT gen_random_uuid(), id, 'line.enable', now() FROM core.lines ORDER BY id LIMIT 1`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('повторная доставка пачки не добавляет ни одной строки', async () => {
    const ingest = await connect(ROLES.ingest, PASSWORDS.ingest);
    const id = await deviceId(ingest, 'RC-101');
    const base = await hoursAgo(ingest, 1);
    const rows: ReadingRow[] = Array.from({ length: 20 }, (_, index) => ({
      ts: new Date(base + index * 10_000).toISOString(),
      deviceId: id,
      metricKey: 'supply_temp_c',
      value: -18 + index / 10,
      quality: 0,
    }));

    expect(await insertReadings(ingest, rows)).toBe(20);
    expect(await insertReadings(ingest, rows)).toBe(0);
    expect(await insertReadings(ingest, [...rows, ...rows])).toBe(0);

    const cycle = {
      ts: new Date(base).toISOString(),
      lineId: 1,
      deviceId: id,
      ok: true,
      errorKind: null,
      durationMs: 42,
      requestCount: 4,
      planMode: 'merged',
    };
    expect(await insertPollCycles(ingest, [cycle])).toBe(1);
    expect(await insertPollCycles(ingest, [cycle])).toBe(0);
  });

  it('часовой агрегат поверх минутного совпадает с прямым расчётом по сырым строкам', async () => {
    const ingest = await connect(ROLES.ingest, PASSWORDS.ingest);
    const owner = await connect(ROLES.migrator, PASSWORDS.migrator);
    const api = await connect(ROLES.api, PASSWORDS.api);
    const id = await deviceId(ingest, 'PM-201');
    const from = await hoursAgo(ingest, 5);
    const rows: ReadingRow[] = [];

    for (let minute = 0; minute < 180; minute += 1) {
      const samples = 1 + ((minute * 7) % 6);
      for (let sample = 0; sample < samples; sample += 1) {
        rows.push({
          ts: new Date(from + minute * 60_000 + sample * 7_000).toISOString(),
          deviceId: id,
          metricKey: 'active_power_kw',
          value: Math.sin(minute / 9) * 10 + sample * 1.37 + minute / 50,
          quality: 0,
        });
      }
    }
    await insertReadings(ingest, rows);

    const windowFrom = new Date(from).toISOString();
    const windowTo = new Date(from + 3 * 3_600_000).toISOString();
    await owner.query(
      `CALL refresh_continuous_aggregate('ts.readings_1m', $1::timestamptz, $2::timestamptz)`,
      [windowFrom, windowTo],
    );
    await owner.query(
      `CALL refresh_continuous_aggregate('ts.readings_1h', $1::timestamptz, $2::timestamptz)`,
      [windowFrom, windowTo],
    );

    const aggregated = await api.query<{
      bucket: Date;
      avg: number;
      min: number;
      max: number;
      n: string;
    }>(
      `SELECT bucket, avg_value AS avg, min_value AS min, max_value AS max, n
       FROM ts.v_readings_1h WHERE device_id = $1 AND metric_key = 'active_power_kw'
       AND bucket >= $2 AND bucket < $3 ORDER BY bucket`,
      [id, windowFrom, windowTo],
    );
    const direct = await api.query<{
      bucket: Date;
      avg: number;
      min: number;
      max: number;
      n: string;
    }>(
      `SELECT time_bucket(INTERVAL '1 hour', ts) AS bucket, avg(value) AS avg, min(value) AS min,
              max(value) AS max, count(value) AS n
       FROM ts.readings WHERE device_id = $1 AND metric_key = 'active_power_kw'
       AND ts >= $2 AND ts < $3 GROUP BY 1 ORDER BY 1`,
      [id, windowFrom, windowTo],
    );

    expect(aggregated.rows).toHaveLength(3);
    aggregated.rows.forEach((row, index) => {
      const expected = direct.rows[index];
      expect(row.bucket.getTime()).toBe(expected?.bucket.getTime());
      expect(Math.abs(row.avg - (expected?.avg ?? Number.NaN))).toBeLessThan(1e-9);
      expect(row.min).toBe(expected?.min);
      expect(row.max).toBe(expected?.max);
      expect(row.n).toBe(expected?.n);
    });
  });

  it('сжатый чанк читается, а в горячий по-прежнему пишется с ON CONFLICT', async () => {
    const ingest = await connect(ROLES.ingest, PASSWORDS.ingest);
    const owner = await connect(ROLES.migrator, PASSWORDS.migrator);
    const id = await deviceId(ingest, 'RC-102');
    const old = await hoursAgo(ingest, 24 * 4);
    const hot = await hoursAgo(ingest, 0);
    const series = (start: number): ReadingRow[] =>
      Array.from({ length: 30 }, (_, index) => ({
        ts: new Date(start + index * 10_000).toISOString(),
        deviceId: id,
        metricKey: 'return_temp_c',
        value: -17 + index / 100,
        quality: 0,
      }));

    await insertReadings(ingest, series(old));
    await owner.query(
      `SELECT compress_chunk(chunk) FROM show_chunks('ts.readings', older_than => INTERVAL '2 days') chunk`,
    );

    const compressed = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM timescaledb_information.chunks
       WHERE hypertable_schema = 'ts' AND hypertable_name = 'readings' AND is_compressed`,
    );
    expect(Number(compressed.rows[0]?.n)).toBeGreaterThanOrEqual(1);

    const readBack = await ingest.query<{ n: string }>(
      `SELECT count(*) AS n FROM ts.readings WHERE device_id = $1 AND ts >= $2 AND ts < $3`,
      [id, new Date(old).toISOString(), new Date(old + 3_600_000).toISOString()],
    );
    expect(readBack.rows[0]?.n).toBe('30');

    expect(await insertReadings(ingest, series(hot))).toBe(30);
    expect(await insertReadings(ingest, series(hot))).toBe(0);
  });
});
