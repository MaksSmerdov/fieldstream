import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { SessionResponse } from '@fieldstream/contracts';
import {
  ROLES,
  bootstrapDatabase,
  connectionUrl,
  runMigrations,
  seedDemoUsers,
} from '@fieldstream/db';
import { createFakeClock } from '@fieldstream/domain';
import { createLogger } from '@fieldstream/nest-common';
import { createApp } from '../../src/bootstrap.js';
import { loadEnv } from '../../src/config/env.js';
import { createMetrics } from '../../src/metrics/metrics.js';

const IMAGE = 'timescale/timescaledb-ha:pg16.6-ts2.17.2';
const SUPERUSER = { user: 'postgres', password: 'superuser-pw' };
const PASSWORDS = { migrator: 'migrator-pw', ingest: 'ingest-pw', api: 'api-pw' };
const SECRET = 'секрет стенда длиной не меньше тридцати двух символов';
const PASSWORD = 'пароль стенда';
const REUSE_WINDOW_MS = 60_000;

/** Часы приложения стартуют от настоящего времени: сроки сессий проверяет сама база. */
const clock = createFakeClock(Date.now());

let container: StartedPostgreSqlContainer;
let app: NestFastifyApplication;
let pool: pg.Pool;
let base: string;

/** Вход демо-пользователя: возвращает тело ответа и cookie с токеном обновления. */
const login = async (
  email: string,
): Promise<{ status: number; body: SessionResponse; cookie: string }> => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const cookie = response.headers.get('set-cookie') ?? '';

  return {
    status: response.status,
    body: (await response.json()) as SessionResponse,
    cookie: cookie.split(';')[0] ?? '',
  };
};

const refresh = async (cookie: string): Promise<Response> =>
  fetch(`${base}/api/auth/refresh`, { method: 'POST', headers: { cookie } });

beforeAll(async () => {
  container = await new PostgreSqlContainer(IMAGE)
    .withDatabase('fieldstream')
    .withUsername(SUPERUSER.user)
    .withPassword(SUPERUSER.password)
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

  const owner = new pg.Client({
    connectionString: connectionUrl(target, ROLES.migrator, PASSWORDS.migrator),
  });
  await owner.connect();
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
  await owner.end();

  pool = new pg.Pool({ connectionString: connectionUrl(target, ROLES.api, PASSWORDS.api), max: 4 });
  app = await createApp({
    env: loadEnv({
      FS_API_PASSWORD: PASSWORDS.api,
      AUTH_SECRET: SECRET,
      REFRESH_REUSE_WINDOW_MS: String(REUSE_WINDOW_MS),
      LOGIN_ATTEMPTS: '5',
      LOGIN_REFILL_MS: '30000',
      SSE_BRIDGE: 'off',
    }),
    log: createLogger('api-gateway', 'fatal'),
    clock,
    metrics: createMetrics(),
    pool,
    instanceId: 'test',
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await container.stop();
});

describe('вход и сессии на настоящей базе', () => {
  it('пускает по паролю и отдаёт права роли', async () => {
    const engineer = await login('engineer@fieldstream.local');

    expect(engineer.status).toBe(200);
    expect(engineer.body.user.role).toBe('engineer');
    expect(engineer.body.user.permissions).toContain('alarm-rules.edit');
    expect(engineer.cookie).toContain('fs_refresh=');

    const viewer = await login('viewer@fieldstream.local');
    expect(viewer.body.user.permissions).not.toContain('alarm-rules.edit');
  });

  it('не пускает с неверным паролем и не подсказывает, что не так', async () => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'engineer@fieldstream.local', password: 'другой пароль' }),
    });

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('пароль неверный');
  });

  /**
   * Ответ на обновление мог потеряться по дороге. Повтор того же токена внутри окна
   * отдаёт ту же пару, а не разлогинивает вкладку.
   */
  it('повтор обновления внутри окна отдаёт ту же пару', async () => {
    const { cookie } = await login('engineer@fieldstream.local');

    const first = await refresh(cookie);
    const second = await refresh(cookie);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as SessionResponse;
    const secondBody = (await second.json()) as SessionResponse;
    expect(secondBody.accessToken).toBe(firstBody.accessToken);
  });

  it('два одновременных обновления: строку получает один, второй берёт ту же пару', async () => {
    const { cookie } = await login('engineer@fieldstream.local');

    const [left, right] = await Promise.all([refresh(cookie), refresh(cookie)]);

    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    const leftBody = (await left.json()) as SessionResponse;
    const rightBody = (await right.json()) as SessionResponse;
    expect(leftBody.accessToken).toBe(rightBody.accessToken);
  });

  it('старый токен вне окна закрывает сессию: так выглядит утечка', async () => {
    const { cookie } = await login('engineer@fieldstream.local');
    const rotated = await refresh(cookie);
    expect(rotated.status).toBe(200);
    const next = (rotated.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    clock.advance(REUSE_WINDOW_MS + 1_000);
    expect((await refresh(cookie)).status).toBe(401);
    expect((await refresh(next)).status).toBe(401);
  });

  it('выход закрывает сессию, обновиться по её токену больше нельзя', async () => {
    const { cookie } = await login('engineer@fieldstream.local');

    const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    expect(logout.status).toBe(204);
    expect((await refresh(cookie)).status).toBe(401);
  });

  /** Ведро попыток живёт в таблице, поэтому перезапуск шлюза не обнуляет счётчик. */
  it('подбор пароля упирается в ограничитель', async () => {
    const attempt = (): Promise<Response> =>
      fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'victim@fieldstream.local', password: 'подбор пароля' }),
      });

    const codes: number[] = [];
    for (let index = 0; index < 8; index += 1) codes.push((await attempt()).status);

    const stopped = codes.indexOf(429);
    expect(stopped).toBeGreaterThan(0);
    expect(codes.slice(0, stopped).every((code) => code === 401)).toBe(true);
    expect(codes.slice(stopped).every((code) => code === 429)).toBe(true);
  });

  /**
   * За обратным прокси адрес запроса это адрес прокси. Без доверия к его заголовкам все
   * попытки входа со стенда попадали бы в одно ведро, и один подбирающий пароль закрывал бы
   * вход всем остальным.
   */
  it('за прокси ограничитель считает попытки по адресу клиента, а не по адресу прокси', async () => {
    const trusting = await createApp({
      env: loadEnv({
        FS_API_PASSWORD: PASSWORDS.api,
        AUTH_SECRET: SECRET,
        TRUST_PROXY: 'on',
        LOGIN_ATTEMPTS: '100',
        LOGIN_IP_ATTEMPTS: '3',
        LOGIN_REFILL_MS: '30000',
        SSE_BRIDGE: 'off',
      }),
      log: createLogger('api-gateway', 'fatal'),
      clock,
      metrics: createMetrics(),
      pool,
      instanceId: 'proxy-test',
    });
    await trusting.listen(0, '127.0.0.1');
    const url = await trusting.getUrl();

    const attempt = (ip: string): Promise<Response> =>
      fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ email: 'stranger@fieldstream.local', password: 'подбор пароля' }),
      });

    const codes: number[] = [];
    for (let index = 0; index < 4; index += 1) codes.push((await attempt('203.0.113.9')).status);
    const neighbour = (await attempt('203.0.113.10')).status;
    await trusting.close();

    expect(codes.at(-1)).toBe(429);
    expect(neighbour).toBe(401);
  });

  it('токен доступа открывает свои данные, а без него ответа нет', async () => {
    const { body } = await login('viewer@fieldstream.local');

    const authorized = await fetch(`${base}/api/me`, {
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(authorized.status).toBe(200);

    expect((await fetch(`${base}/api/me`)).status).toBe(401);
  });
});
