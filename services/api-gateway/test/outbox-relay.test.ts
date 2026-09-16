import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { TOPICS } from '@fieldstream/contracts';
import { createFakeClock } from '@fieldstream/domain';
import type { OutgoingMessage } from '@fieldstream/kafka';
import { createLogger } from '@fieldstream/nest-common';
import { FINAL_ATTEMPTS, OutboxRelayService } from '../src/commands/outbox-relay.service.js';
import { loadEnv } from '../src/config/env.js';
import type { ProducerService } from '../src/publish/producer.service.js';

const START = Date.parse('2026-09-11T10:00:00Z');
const COMMANDS = TOPICS.deviceCommands.name;

const ENV = loadEnv({
  FS_API_PASSWORD: 'тест',
  AUTH_SECRET: 'секрет стенда длиной не меньше тридцати двух символов',
  SSE_BRIDGE: 'off',
  PIPELINE_SAMPLER: 'off',
  COLLECTOR_STATUS: 'off',
  LOG_LEVEL: 'fatal',
});

interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Команда, которая проходит схему своего топика. */
const command = (): Record<string, unknown> => ({
  schema: 'device.command',
  v: 1,
  commandId: '6f1e8f0a-2c9d-4f3a-9a1f-1d2c3b4a5e6f',
  issuedBy: 'engineer@fieldstream.local',
  siteCode: 'SITE-A',
  lineCode: 'L1',
  kind: 'line.enable',
  args: {},
  issuedAt: new Date(START).toISOString(),
  expiresAt: new Date(START + 60_000).toISOString(),
  traceId: 'тест-команды',
});

const row = (id: string, attempts: number, payload: unknown) => ({
  id,
  topic: COMMANDS,
  msg_key: 'SITE-A',
  payload,
  attempts,
});

/** База, которая отдаёт заданную пачку очереди и запоминает всё, что ей прислали. */
const fakeDb = (
  rows: readonly ReturnType<typeof row>[],
): { pool: pg.Pool; statements: Statement[] } => {
  const statements: Statement[] = [];
  const client = {
    query: (sql: string, params: readonly unknown[] = []) => {
      statements.push({ sql, params });
      if (sql.includes('SET lock_id = $1')) return Promise.resolve({ rows, rowCount: rows.length });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release: () => undefined,
  };

  return { pool: { connect: () => Promise.resolve(client) } as unknown as pg.Pool, statements };
};

/** Продюсер, чья отправка управляется тестом. */
const fakeProducer = (send: (messages: readonly OutgoingMessage[]) => Promise<void>) => {
  const sent = vi.fn(send);
  return {
    sent,
    producer: {
      isConnected: () => true,
      send: sent,
      encode: (_spec: unknown, payload: unknown) => ({ topic: COMMANDS, payload }),
    } as unknown as ProducerService,
  };
};

const service = (pool: pg.Pool, producer: ProducerService): OutboxRelayService =>
  new OutboxRelayService(
    ENV,
    pool,
    createFakeClock(START),
    createLogger('api-gateway', 'silent'),
    producer,
  );

const kinds = (statements: readonly Statement[]): string[] =>
  statements.map(({ sql }) => {
    if (sql.includes('SET lock_id = $1')) return 'claim';
    if (sql.includes('final_rejected = true')) return 'reject';
    if (sql.includes('SET last_error')) return 'defer';
    if (sql.includes('SET published_at')) return 'publish';
    return sql;
  });

const paramsOf = (statements: readonly Statement[], kind: string): readonly unknown[] | undefined =>
  statements.find((statement) => kinds([statement])[0] === kind)?.params;

describe('рассылка очереди исходящих', () => {
  it('строку, которую не принимает схема топика, откладывает до предела попыток', async () => {
    const db = fakeDb([row('11', FINAL_ATTEMPTS - 1, { kind: 'line.enable' })]);
    const { producer, sent } = fakeProducer(() => Promise.resolve());

    await expect(service(db.pool, producer).tick()).resolves.toBe(0);

    expect(kinds(db.statements)).toEqual(['claim', 'defer']);
    expect(paramsOf(db.statements, 'defer')?.[0]).toEqual(['11']);
    expect(sent).not.toHaveBeenCalled();
  });

  it('с предельной попытки строка получает окончательный отказ и больше не перекладывается', async () => {
    const db = fakeDb([
      row('11', FINAL_ATTEMPTS, { kind: 'line.enable' }),
      row('12', FINAL_ATTEMPTS + 4, {}),
    ]);
    const { producer } = fakeProducer(() => Promise.resolve());

    await expect(service(db.pool, producer).tick()).resolves.toBe(0);

    expect(kinds(db.statements)).toEqual(['claim', 'reject']);
    expect(paramsOf(db.statements, 'reject')?.[0]).toEqual(['11', '12']);
  });

  it('отказ одной строки не мешает уйти соседней, которая схему проходит', async () => {
    const db = fakeDb([row('11', FINAL_ATTEMPTS, {}), row('12', 1, command())]);
    const { producer, sent } = fakeProducer(() => Promise.resolve());

    await expect(service(db.pool, producer).tick()).resolves.toBe(1);

    expect(kinds(db.statements)).toEqual(['claim', 'reject', 'publish']);
    expect(paramsOf(db.statements, 'reject')?.[0]).toEqual(['11']);
    expect(paramsOf(db.statements, 'publish')?.[0]).toEqual(['12']);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('очередь берётся без отказанных строк', async () => {
    const db = fakeDb([]);
    const { producer } = fakeProducer(() => Promise.resolve());

    await expect(service(db.pool, producer).tick()).resolves.toBe(0);

    expect(db.statements[0]?.sql).toContain('NOT final_rejected');
  });
});
