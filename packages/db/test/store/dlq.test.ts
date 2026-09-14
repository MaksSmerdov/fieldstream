import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { loadDlqCounts } from '../../src/store/dlq.js';

describe('счёт очереди недоставленных', () => {
  it('счётчики базы приходят строками, а отдаются числами', async () => {
    const client = {
      query: () => Promise.resolve({ rows: [{ unresolved: '3', total: '12' }] }),
    } as unknown as pg.ClientBase;

    await expect(loadDlqCounts(client)).resolves.toEqual({ unresolved: 3, total: 12 });
  });
});
