import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  alarmRuleAuditResponseSchema,
  alarmRulesResponseSchema,
  alarmRulesUpdateResponseSchema,
  alarmsResponseSchema,
} from '@fieldstream/contracts';
import type { AlarmRuleUpdate, SessionResponse } from '@fieldstream/contracts';
import { DEFAULT_ALARM_RULES, DEMO_STAND, DEVICE_PROFILES } from '@fieldstream/device-profiles';
import {
  ROLES,
  bootstrapDatabase,
  connectionUrl,
  insertAlarmEvents,
  runMigrations,
  seedDemoUsers,
  syncAlarmRules,
  syncTopology,
} from '@fieldstream/db';
import { alarmDedupeKey, alarmIdOf, createFakeClock, toIsoTimestamp } from '@fieldstream/domain';
import { createLogger } from '@fieldstream/nest-common';
import { createApp } from '../../src/bootstrap.js';
import { loadEnv } from '../../src/config/env.js';
import { createMetrics } from '../../src/metrics/metrics.js';

const IMAGE = 'timescale/timescaledb-ha:pg16.6-ts2.17.2';
/** Планировщик TimescaleDB выключен: политики просыпаются посреди теста, а агрегаты тесты обновляют сами. */
const NO_BACKGROUND_JOBS = ['postgres', '-c', 'timescaledb.max_background_workers=0'];
const SUPERUSER = { user: 'postgres', password: 'superuser-pw' };
const PASSWORDS = { migrator: 'migrator-pw', ingest: 'ingest-pw', api: 'api-pw' };
const SECRET = 'секрет стенда длиной не меньше тридцати двух символов';
const PASSWORD = 'пароль стенда';
const DEVICE = 'RC-101';
const OTHER = 'RC-102';

const clock = createFakeClock(Date.now());

let container: StartedPostgreSqlContainer;
let app: NestFastifyApplication;
let pool: pg.Pool;
let owner: pg.Client;
let base: string;
let engineerToken: string;
let viewerToken: string;

const login = async (email: string): Promise<string> => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });

  return ((await response.json()) as SessionResponse).accessToken;
};

const call = async (
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<{ status: number; json: unknown }> => {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  });

  return { status: response.status, json: await response.json().catch(() => null) };
};

/** Эпизоды алармов кладутся прямо в базу ролью процессора: лента читает то, что он пишет. */
const seedAlarms = async (client: pg.ClientBase): Promise<void> => {
  const devices = await client.query<{ id: number; code: string }>(
    'SELECT id, code FROM core.devices WHERE code = ANY($1::text[])',
    [[DEVICE, OTHER]],
  );
  const idOf = (code: string): number => {
    const found = devices.rows.find((row) => row.code === code)?.id;
    if (found === undefined) throw new Error(`нет прибора ${code}`);
    return found;
  };

  const base = clock.now() - 6 * 3_600_000;
  const rows = [
    {
      code: DEVICE,
      metric: 'supply_temp_c',
      severity: 'warning' as const,
      at: base,
      cleared: true,
    },
    {
      code: DEVICE,
      metric: 'superheat_k',
      severity: 'critical' as const,
      at: base + 60_000,
      cleared: false,
    },
    {
      code: OTHER,
      metric: 'supply_temp_c',
      severity: 'info' as const,
      at: base + 120_000,
      cleared: false,
    },
  ];

  await insertAlarmEvents(
    client,
    rows.map((row) => {
      const dedupeKey = alarmDedupeKey({
        deviceCode: row.code,
        metricKey: row.metric,
        mode: 'cooling',
        raisedAt: row.at,
      });

      return {
        alarmId: alarmIdOf(dedupeKey),
        deviceId: idOf(row.code),
        metricKey: row.metric,
        mode: 'cooling' as const,
        severity: row.severity,
        boundary: 'max' as const,
        value: 5,
        threshold: 2,
        occurredAt: toIsoTimestamp(row.at),
        dedupeKey,
      };
    }),
  );

  const closed = rows.find((row) => row.cleared);
  if (closed !== undefined) {
    await client.query(
      `UPDATE core.alarm_events SET cleared_at = $2, cleared_value = 1 WHERE dedupe_key = $1`,
      [
        alarmDedupeKey({
          deviceCode: closed.code,
          metricKey: closed.metric,
          mode: 'cooling',
          raisedAt: closed.at,
        }),
        toIsoTimestamp(closed.at + 300_000),
      ],
    );
  }
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
    {
      email: 'engineer@fieldstream.local',
      displayName: 'Инженер',
      role: 'engineer',
      password: PASSWORD,
    },
    {
      email: 'viewer@fieldstream.local',
      displayName: 'Наблюдатель',
      role: 'viewer',
      password: PASSWORD,
    },
  ]);

  const ingest = new pg.Client({
    connectionString: connectionUrl(target, ROLES.ingest, PASSWORDS.ingest),
  });
  await ingest.connect();
  await seedAlarms(ingest);
  await ingest.end();

  pool = new pg.Pool({ connectionString: connectionUrl(target, ROLES.api, PASSWORDS.api), max: 4 });
  app = await createApp({
    env: loadEnv({
      FS_API_PASSWORD: PASSWORDS.api,
      AUTH_SECRET: SECRET,
      SSE_BRIDGE: 'off',
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

  engineerToken = await login('engineer@fieldstream.local');
  viewerToken = await login('viewer@fieldstream.local');
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await container.stop();
});

describe('лента алармов', () => {
  it('отдаёт эпизоды от свежих к старым и различает активные и снятые', async () => {
    const { status, json } = await call('/api/alarms', engineerToken);
    const page = alarmsResponseSchema.parse(json);

    expect(status).toBe(200);
    expect(page.items).toHaveLength(3);
    expect(page.items.map((item) => item.active)).toEqual([true, true, false]);
    expect(page.nextCursor).toBeNull();
  });

  it('фильтры складываются: состояние, важность и прибор', async () => {
    const active = alarmsResponseSchema.parse(
      (await call('/api/alarms?state=active', engineerToken)).json,
    );
    expect(active.items.every((item) => item.clearedAt === null)).toBe(true);

    const critical = alarmsResponseSchema.parse(
      (await call('/api/alarms?severity=critical', engineerToken)).json,
    );
    expect(critical.items.map((item) => item.metricKey)).toEqual(['superheat_k']);

    const byDevice = alarmsResponseSchema.parse(
      (await call(`/api/alarms?device=${OTHER}`, engineerToken)).json,
    );
    expect(byDevice.items.every((item) => item.deviceCode === OTHER)).toBe(true);
  });

  /** Страница берётся курсором: свежий аларм не сдвигает уже показанные строки. */
  it('листается курсором без пропусков и повторов', async () => {
    const first = alarmsResponseSchema.parse(
      (await call('/api/alarms?limit=2', engineerToken)).json,
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = alarmsResponseSchema.parse(
      (await call(`/api/alarms?limit=2&cursor=${first.nextCursor ?? ''}`, engineerToken)).json,
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const ids = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('испорченный курсор это ошибка запроса, а не пустая страница', async () => {
    expect((await call('/api/alarms?cursor=не-курсор', engineerToken)).status).toBe(400);
  });

  it('подтверждение остаётся за первым, кто его сделал', async () => {
    const page = alarmsResponseSchema.parse(
      (await call('/api/alarms?limit=1', engineerToken)).json,
    );
    const target = page.items[0];
    if (target === undefined) throw new Error('лента пуста');

    const acked = await call(`/api/alarms/${target.id}/ack`, engineerToken, {
      method: 'POST',
      body: '{}',
    });
    expect(acked.status).toBe(201);

    const again = await call(`/api/alarms/${target.id}/ack`, engineerToken, {
      method: 'POST',
      body: '{}',
    });
    expect(again.status).toBe(201);

    const list = alarmsResponseSchema.parse(
      (await call('/api/alarms?limit=1', engineerToken)).json,
    );
    expect(list.items[0]?.ackedBy).toBe('engineer@fieldstream.local');
  });

  it('наблюдатель видит ленту, но подтвердить не может', async () => {
    const page = alarmsResponseSchema.parse((await call('/api/alarms?limit=1', viewerToken)).json);
    const target = page.items[0];
    if (target === undefined) throw new Error('лента пуста');

    const attempt = await call(`/api/alarms/${target.id}/ack`, viewerToken, {
      method: 'POST',
      body: '{}',
    });
    expect(attempt.status).toBe(403);
  });
});

describe('уставки прибора', () => {
  const change: AlarmRuleUpdate = {
    metricKey: 'supply_temp_c',
    mode: 'cooling',
    minValue: -30,
    maxValue: -5,
    hysteresis: 1.5,
    debounceCycles: 4,
    severity: 'critical',
    enabled: true,
  };

  it('отдаются по режимам: в оттайке границы шире', async () => {
    const { json } = await call(`/api/devices/${DEVICE}/alarm-rules`, engineerToken);
    const response = alarmRulesResponseSchema.parse(json);

    const cooling = response.rules.find(
      (rule) => rule.metricKey === 'supply_temp_c' && rule.mode === 'cooling',
    );
    const defrost = response.rules.find(
      (rule) => rule.metricKey === 'supply_temp_c' && rule.mode === 'defrost',
    );
    expect(cooling?.maxValue ?? 0).toBeLessThan(defrost?.maxValue ?? 0);
  });

  it('правка меняет значения и оставляет след в истории', async () => {
    const { status, json } = await call(`/api/devices/${DEVICE}/alarm-rules`, engineerToken, {
      method: 'PUT',
      body: JSON.stringify({ rules: [change] }),
    });
    const response = alarmRulesUpdateResponseSchema.parse(json);

    expect(status).toBe(200);
    expect(response.changes).toHaveLength(1);
    expect(response.changes[0]?.changed).toContain('maxValue');
    expect(response.changes[0]?.created).toBe(false);

    const updated = response.rules.find(
      (rule) => rule.metricKey === 'supply_temp_c' && rule.mode === 'cooling',
    );
    expect(updated?.maxValue).toBe(-5);
    expect(updated?.updatedBy).toBe('engineer@fieldstream.local');

    const audit = await owner.query<{ n: string; changed_by: string }>(
      `SELECT count(*) AS n, min(changed_by) AS changed_by FROM core.alarm_rule_audit`,
    );
    expect(Number(audit.rows[0]?.n)).toBe(1);
    expect(audit.rows[0]?.changed_by).toBe('engineer@fieldstream.local');
  });

  /** «Уставка изменена» без прежнего числа не даёт понять, что именно произошло. */
  it('журнал правок показывает поля с прежним и новым значением', async () => {
    const { status, json } = await call(`/api/devices/${DEVICE}/alarm-rules/audit`, engineerToken);
    const response = alarmRuleAuditResponseSchema.parse(json);

    expect(status).toBe(200);
    expect(response.items).toHaveLength(1);

    const entry = response.items[0];
    expect(entry?.changedBy).toBe('engineer@fieldstream.local');
    expect(entry?.created).toBe(false);

    const maxValue = entry?.fields.find((field) => field.field === 'maxValue');
    expect(maxValue?.after).toBe(-5);
    expect(maxValue?.before).not.toBe(-5);
    expect(entry?.fields.map((field) => field.field)).toContain('severity');
  });

  it('журнал виден и тому, кто править уставки не вправе', async () => {
    const { status, json } = await call(`/api/devices/${DEVICE}/alarm-rules/audit`, viewerToken);

    expect(status).toBe(200);
    expect(alarmRuleAuditResponseSchema.parse(json).items).toHaveLength(1);
  });

  it('повторная правка теми же значениями ничего не меняет и следа не оставляет', async () => {
    const { json } = await call(`/api/devices/${DEVICE}/alarm-rules`, engineerToken, {
      method: 'PUT',
      body: JSON.stringify({ rules: [change] }),
    });

    expect(alarmRulesUpdateResponseSchema.parse(json).changes).toHaveLength(0);
    const audit = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM core.alarm_rule_audit',
    );
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });

  it('уставка без границ и с перевёрнутыми границами отвергается', async () => {
    const empty = await call(`/api/devices/${DEVICE}/alarm-rules`, engineerToken, {
      method: 'PUT',
      body: JSON.stringify({ rules: [{ ...change, minValue: null, maxValue: null }] }),
    });
    expect(empty.status).toBe(400);

    const inverted = await call(`/api/devices/${DEVICE}/alarm-rules`, engineerToken, {
      method: 'PUT',
      body: JSON.stringify({ rules: [{ ...change, minValue: 10, maxValue: -10 }] }),
    });
    expect(inverted.status).toBe(400);
  });

  it('наблюдатель уставки видит, но править не может', async () => {
    expect((await call(`/api/devices/${DEVICE}/alarm-rules`, viewerToken)).status).toBe(200);

    const attempt = await call(`/api/devices/${DEVICE}/alarm-rules`, viewerToken, {
      method: 'PUT',
      body: JSON.stringify({ rules: [change] }),
    });
    expect(attempt.status).toBe(403);
  });
});
