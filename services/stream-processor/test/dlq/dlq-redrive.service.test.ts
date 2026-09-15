import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { KAFKA_HEADERS, TOPICS } from '@fieldstream/contracts';
import { createFakeClock } from '@fieldstream/domain';
import type { RawOutgoingMessage } from '@fieldstream/kafka';
import { createLogger } from '@fieldstream/nest-common';
import { loadEnv } from '../../src/config/env.js';
import { DlqRedriveService, STALE_RUNNING_ERROR } from '../../src/dlq/dlq-redrive.service.js';
import type { ProducerService } from '../../src/publish/producer.service.js';

const START = Date.parse('2026-09-11T10:00:00Z');
const RAW = TOPICS.telemetryRaw.name;

const ENV = loadEnv({
  KAFKA_BROKERS: 'localhost:9092',
  DATABASE_HOST: 'localhost',
  DATABASE_PORT: '5432',
  POSTGRES_DB: 'fieldstream',
  FS_INGEST_PASSWORD: 'ingest-pw',
  DLQ_REDRIVE: 'on',
  LOG_LEVEL: 'fatal',
});

interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface FakeDb {
  readonly pool: pg.Pool;
  readonly statements: Statement[];
  readonly released: boolean[];
}

const REQUEST_ROW = {
  id: '7',
  status: 'running',
  max_messages: 50,
  redriven: 0,
  rejected: 0,
  error: null,
  requested_by: 'engineer@fieldstream.local',
  created_at: new Date(START - 5_000),
  started_at: new Date(START),
  finished_at: null,
};

const candidate = (id: string, attempts: number) => ({
  id,
  source_topic: RAW,
  key: 'RC-102',
  headers: { [KAFKA_HEADERS.traceId]: 'poison' },
  payload: Buffer.from('{не json'),
  attempts,
  first_seen: new Date(START - 60_000),
});

/** База, которая отвечает по тексту запроса и запоминает всё, что ей прислали. */
const fakeDb = (rows: { queued: boolean; stale?: number }): FakeDb => {
  const statements: Statement[] = [];
  const released: boolean[] = [];
  const client = {
    query: (sql: string, params: readonly unknown[] = []) => {
      statements.push({ sql, params });
      if (sql.includes(`SET status = 'failed'`)) {
        return Promise.resolve({ rows: [], rowCount: rows.stale ?? 0 });
      }
      if (sql.includes(`SET status = 'running'`)) {
        const claimed = rows.queued ? [REQUEST_ROW] : [];
        return Promise.resolve({ rows: claimed, rowCount: claimed.length });
      }
      if (sql.includes('FOR UPDATE SKIP LOCKED') && sql.includes('core.dlq_message')) {
        return Promise.resolve({ rows: [candidate('11', 1), candidate('12', 3)], rowCount: 2 });
      }
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

/** Продюсер, чья отправка управляется тестом. */
const fakeProducer = (send: (messages: readonly RawOutgoingMessage[]) => Promise<void>) => {
  const sendRaw = vi.fn(send);
  return {
    sendRaw,
    producer: { isConnected: () => true, sendRaw } as unknown as ProducerService,
  };
};

const service = (db: FakeDb, producer: ProducerService): DlqRedriveService =>
  new DlqRedriveService(
    ENV,
    createLogger('stream-processor', 'silent'),
    createFakeClock(START),
    db.pool,
    producer,
  );

const kinds = (statements: readonly Statement[]): string[] =>
  statements.map(({ sql }) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return sql;
    if (sql.includes(`SET status = 'failed'`)) return 'recover';
    if (sql.includes(`SET status = 'running'`)) return 'claim';
    if (sql.includes('FOR UPDATE SKIP LOCKED')) return 'select';
    if (sql.includes('final_rejected = true')) return 'reject';
    if (sql.includes('SET resolved_at')) return 'resolve';
    if (sql.includes('UPDATE core.dlq_redrive')) return 'finish';
    return sql;
  });

const finishOf = (statements: readonly Statement[]): readonly unknown[] | undefined =>
  statements.find(({ sql }) => kinds([{ sql, params: [] }])[0] === 'finish')?.params;

describe('повторная подача из очереди недоставленных', () => {
  it('забор запроса, отбор, отправка и завершение идут одной транзакцией', async () => {
    const db = fakeDb({ queued: true });
    const { producer, sendRaw } = fakeProducer(() => Promise.resolve());

    await expect(service(db, producer).tick()).resolves.toBe(true);

    expect(kinds(db.statements)).toEqual([
      'BEGIN',
      'recover',
      'COMMIT',
      'BEGIN',
      'claim',
      'select',
      'reject',
      'resolve',
      'finish',
      'COMMIT',
    ]);
    const sent = sendRaw.mock.calls[0]?.[0] ?? [];
    expect(sent.map((message) => message.headers[KAFKA_HEADERS.dlqRedriveOf])).toEqual(['11']);
    expect(finishOf(db.statements)).toEqual(['7', 'done', 1, 1, null, '2026-09-11T10:00:00.000Z']);
  });

  it('сбой отправки откатывает отметки и забор, а запрос отдельно завершается с ошибкой', async () => {
    const db = fakeDb({ queued: true });
    const { producer } = fakeProducer(() =>
      Promise.reject(new Error('брокер не принял сообщение')),
    );

    await expect(service(db, producer).tick()).resolves.toBe(true);

    expect(kinds(db.statements)).toEqual([
      'BEGIN',
      'recover',
      'COMMIT',
      'BEGIN',
      'claim',
      'select',
      'reject',
      'ROLLBACK',
      'BEGIN',
      'finish',
      'COMMIT',
    ]);
    expect(finishOf(db.statements)).toEqual([
      '7',
      'failed',
      0,
      0,
      'брокер не принял сообщение',
      '2026-09-11T10:00:00.000Z',
    ]);
    expect(db.released).toEqual([false, true, false]);
  });

  it('брошенные в работе запросы завершаются с ошибкой один раз после старта', async () => {
    const db = fakeDb({ queued: false, stale: 2 });
    const { producer } = fakeProducer(() => Promise.resolve());
    const redrive = service(db, producer);

    await expect(redrive.tick()).resolves.toBe(false);
    await expect(redrive.tick()).resolves.toBe(false);

    expect(kinds(db.statements)).toEqual([
      'BEGIN',
      'recover',
      'COMMIT',
      'BEGIN',
      'claim',
      'COMMIT',
      'BEGIN',
      'claim',
      'COMMIT',
    ]);
    expect(db.statements.find(({ sql }) => sql.includes(`SET status = 'failed'`))?.params).toEqual([
      STALE_RUNNING_ERROR,
      '2026-09-11T10:00:00.000Z',
    ]);
  });

  it('недоступная база не пишет сбой и не ломает следующий такт', async () => {
    const { producer, sendRaw } = fakeProducer(() => Promise.resolve());
    const connect = vi.fn(() => Promise.reject(new Error('база недоступна')));
    const db: FakeDb = {
      pool: { connect } as unknown as pg.Pool,
      statements: [],
      released: [],
    };
    const redrive = service(db, producer);

    await expect(redrive.tick()).resolves.toBe(false);
    await expect(redrive.tick()).resolves.toBe(false);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it('пустая очередь запросов не открывает отправку', async () => {
    const db = fakeDb({ queued: false });
    const { producer, sendRaw } = fakeProducer(() => Promise.resolve());

    await expect(service(db, producer).tick()).resolves.toBe(false);

    expect(kinds(db.statements)).toEqual([
      'BEGIN',
      'recover',
      'COMMIT',
      'BEGIN',
      'claim',
      'COMMIT',
    ]);
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it('остановка дожидается начатого запроса и не берёт новый', async () => {
    const db = fakeDb({ queued: true });
    let deliver: () => void = () => undefined;
    const { producer, sendRaw } = fakeProducer(
      () =>
        new Promise<void>((resolve) => {
          deliver = resolve;
        }),
    );
    const redrive = service(db, producer);

    const running = redrive.tick();
    await vi.waitFor(() => {
      expect(sendRaw).toHaveBeenCalledTimes(1);
    });

    let stopped = false;
    const stopping = redrive.beforeApplicationShutdown().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    expect(kinds(db.statements).slice(0, 3)).toEqual(['BEGIN', 'recover', 'COMMIT']);
    expect(kinds(db.statements).slice(3)).not.toContain('COMMIT');

    deliver();
    await stopping;

    await expect(running).resolves.toBe(true);
    expect(kinds(db.statements).slice(-2)).toEqual(['finish', 'COMMIT']);
    await expect(redrive.tick()).resolves.toBe(false);
    expect(sendRaw).toHaveBeenCalledTimes(1);
  });
});
