import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_STAND, DEVICE_PROFILES, rc2000Profile } from '@fieldstream/device-profiles';
import { connectionUrl } from '../../src/setup/connection.js';
import type { ConnectionTarget } from '../../src/setup/connection.js';
import { runMigrations } from '../../src/setup/migrate.js';
import { ROLES, bootstrapDatabase } from '../../src/setup/roles.js';
import { loadDeviceRefs, syncTopology } from '../../src/store/topology.js';
import { insertPollCycles, insertReadings } from '../../src/store/writer.js';
import type { ReadingRow } from '../../src/store/writer.js';

const IMAGE = 'timescale/timescaledb-ha:pg16.6-ts2.17.2';
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

    const down = await runMigrations({ databaseUrl: migratorUrl(), direction: 'down' });
    expect(down).toHaveLength(7);
    expect(await exists('ts.readings')).toBe(false);
    expect(await exists('core.devices')).toBe(false);

    const up = await runMigrations({ databaseUrl: migratorUrl(), direction: 'up' });
    expect(up).toHaveLength(7);
    expect(await exists('ts.readings_1h')).toBe(true);

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
