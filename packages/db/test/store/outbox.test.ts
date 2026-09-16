import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { claimOutbox, loadCommandProgress, markOutboxRejected } from '../../src/store/outbox.js';

const COMMAND_ID = '6f1e8f0a-2c9d-4f3a-9a1f-1d2c3b4a5e6f';
const ISSUED_AT = new Date('2026-09-11T10:00:00Z');

interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** База, отвечающая одной заготовленной пачкой и запоминающая всё, что ей прислали. */
const fakeClient = (
  rows: readonly Record<string, unknown>[],
): { client: pg.ClientBase; statements: Statement[] } => {
  const statements: Statement[] = [];
  const client = {
    query: (sql: string, params: readonly unknown[] = []) => {
      statements.push({ sql, params });
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };

  return { client: client as unknown as pg.ClientBase, statements };
};

describe('очередь исходящих', () => {
  it('забирает только неотказанные строки, готовые к отправке', async () => {
    const { client, statements } = fakeClient([
      {
        id: '11',
        topic: 'fieldstream.device.commands.v1',
        msg_key: 'SITE-A',
        payload: {},
        attempts: 2,
      },
    ]);

    await expect(claimOutbox(client, 'замок', 100)).resolves.toEqual([
      {
        id: '11',
        topic: 'fieldstream.device.commands.v1',
        msgKey: 'SITE-A',
        payload: {},
        attempts: 2,
      },
    ]);
    expect(statements[0]?.sql).toContain('published_at IS NULL AND NOT final_rejected');
  });

  it('окончательный отказ пишется с причиной, а пустой список базу не трогает', async () => {
    const { client, statements } = fakeClient([]);

    await markOutboxRejected(client, ['11', '12'], 'сообщение не разбирается схемой своего топика');
    await markOutboxRejected(client, [], 'причина');

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain('final_rejected = true');
    expect(statements[0]?.params).toEqual([
      ['11', '12'],
      'сообщение не разбирается схемой своего топика',
    ]);
  });

  it('отказанная команда видна как отклонённая, а не как ждущая отправки', async () => {
    const { client } = fakeClient([
      {
        created_at: ISSUED_AT,
        published_at: null,
        attempts: 3,
        final_rejected: true,
        last_error: 'сообщение не разбирается схемой своего топика',
        applied_at: null,
        result: null,
      },
    ]);

    await expect(loadCommandProgress(client, COMMAND_ID)).resolves.toMatchObject({
      stage: 'rejected',
      detail: 'сообщение не разбирается схемой своего топика',
      attempts: 3,
    });
  });

  it('пока строка ждёт своей очереди, команда остаётся ждущей', async () => {
    const { client } = fakeClient([
      {
        created_at: ISSUED_AT,
        published_at: null,
        attempts: 1,
        final_rejected: false,
        last_error: null,
        applied_at: null,
        result: null,
      },
    ]);

    await expect(loadCommandProgress(client, COMMAND_ID)).resolves.toMatchObject({
      stage: 'queued',
      detail: null,
    });
  });
});
