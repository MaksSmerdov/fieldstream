import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ROLES,
  bootstrapDatabase,
  connectionUrl,
  runMigrations,
  syncTopology,
} from '@fieldstream/db';
import { DEMO_STAND, DEVICE_PROFILES } from '@fieldstream/device-profiles';
import { refreshAggregates, seedHistory } from '../../src/seed.js';
import type { SeedReport } from '../../src/seed.js';

const IMAGE = 'timescale/timescaledb-ha:pg16.6-ts2.17.2';
/** Планировщик TimescaleDB выключен: политики просыпаются посреди теста, а агрегаты тесты обновляют сами. */
const NO_BACKGROUND_JOBS = ['postgres', '-c', 'timescaledb.max_background_workers=0'];
const SUPERUSER = { user: 'postgres', password: 'superuser-pw' };
const PASSWORDS = { migrator: 'migrator-pw', ingest: 'ingest-pw', api: 'api-pw' };
const DAYS = 2;
const DEVICE = 'RC-101';

let container: StartedPostgreSqlContainer;
let owner: pg.Client;
let first: SeedReport;
let until: Date;

const count = async (sql: string, params: unknown[] = []): Promise<number> => {
  const result = await owner.query<{ n: string }>(sql, params);

  return Number(result.rows[0]?.n ?? 0);
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

  until = new Date(Date.now());
  first = await seedHistory(owner, { days: DAYS, until });
}, 300_000);

afterAll(async () => {
  await owner.end();
  await container.stop();
});

describe('засев истории', () => {
  it('окно засева выровнено по часу и накрывает заданные сутки', () => {
    expect(first.readings).toBeGreaterThan(0);
    expect(Date.parse(first.from) % 3_600_000).toBe(0);
    expect(Date.parse(first.to) - Date.parse(first.from)).toBe(DAYS * 86_400_000);
  });

  /** Полоса режимов и кривая обязаны рассказывать об одном часе одно и то же. */
  it('оттайка это и событие, и подъём температуры испарителя в те же минуты', async () => {
    expect(first.defrosts).toBeGreaterThan(0);

    const events = await count(
      `SELECT count(*) AS n FROM core.device_events e
       JOIN core.devices d ON d.id = e.device_id
       WHERE e.kind = 'mode_changed' AND d.profile_key = 'rc-2000'`,
    );
    expect(events).toBe(first.defrosts * 2);

    const compared = await owner.query<{ inside: string | null; outside: string | null }>(
      `WITH windows AS (
         SELECT e.device_id, e.occurred_at
         FROM core.device_events e
         JOIN core.devices d ON d.id = e.device_id
         WHERE e.kind = 'mode_changed' AND e.payload ->> 'to' = 'defrost' AND d.code = $1
       )
       SELECT avg(CASE WHEN w.occurred_at IS NOT NULL THEN r.value END) AS inside,
              avg(CASE WHEN w.occurred_at IS NULL THEN r.value END) AS outside
       FROM ts.readings r
       JOIN core.devices d ON d.id = r.device_id
       LEFT JOIN windows w
         ON w.device_id = r.device_id
        AND r.ts >= w.occurred_at AND r.ts < w.occurred_at + INTERVAL '20 minutes'
       WHERE d.code = $1 AND r.metric_key = 'evap_temp_c'`,
      [DEVICE],
    );
    const row = compared.rows[0];
    expect(Number(row?.inside)).toBeGreaterThan(Number(row?.outside) + 5);
  });

  /**
   * Повтор засева на том же окне ничего не добавляет и не правит значения второй раз:
   * подъём температуры аддитивный, и без этой проверки второй запуск тихо задирал бы историю.
   * Окно при этом вырождается в пустое, и пересчёт агрегатов обязан его пропустить: иначе
   * TimescaleDB отвечает «refresh window too small», и стенд после перезапуска не готов.
   */
  it('повторный засев ничего не добавляет, не задирает значения и не рушит пересчёт', async () => {
    const before = await owner.query<{ sum: string; rows: string }>(
      `SELECT coalesce(sum(value), 0)::text AS sum, count(*)::text AS rows FROM ts.readings`,
    );

    const again = await seedHistory(owner, { days: DAYS, until });

    const after = await owner.query<{ sum: string; rows: string }>(
      `SELECT coalesce(sum(value), 0)::text AS sum, count(*)::text AS rows FROM ts.readings`,
    );

    expect(again.readings).toBe(0);
    expect(again.defrosts).toBe(0);
    expect(after.rows[0]?.rows).toBe(before.rows[0]?.rows);
    expect(Number(after.rows[0]?.sum)).toBeCloseTo(Number(before.rows[0]?.sum), 3);
    await expect(refreshAggregates(owner, again.from, again.to)).resolves.toBe(false);
  });

  /** Без пересчёта длинные графики пусты: агрегаты сами догоняют только свежие данные. */
  it('пересчёт агрегатов наполняет минутную и часовую выборки на засеянном окне', async () => {
    await refreshAggregates(owner, first.from, first.to);

    const minutes = await count(
      `SELECT count(*) AS n FROM ts.v_readings_1m v
       JOIN core.devices d ON d.id = v.device_id
       WHERE d.code = $1 AND v.bucket >= $2 AND v.bucket < $3`,
      [DEVICE, first.from, first.to],
    );
    const hours = await count(
      `SELECT count(*) AS n FROM ts.v_readings_1h v
       JOIN core.devices d ON d.id = v.device_id
       WHERE d.code = $1 AND v.bucket >= $2 AND v.bucket < $3`,
      [DEVICE, first.from, first.to],
    );

    expect(minutes).toBeGreaterThan(0);
    expect(hours).toBeGreaterThan(0);
  });
});
