import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { PAYLOAD_PREVIEW_BYTES, loadDlqCounts, payloadPreview } from '../../src/store/dlq.js';

describe('счёт очереди недоставленных', () => {
  it('счётчики базы приходят строками, а отдаются числами', async () => {
    const client = {
      query: () => Promise.resolve({ rows: [{ unresolved: '3', total: '12' }] }),
    } as unknown as pg.ClientBase;

    await expect(loadDlqCounts(client)).resolves.toEqual({ unresolved: 3, total: 12 });
  });
});

describe('текст первых байтов сообщения', () => {
  it('печатное остаётся как есть, включая кириллицу', () => {
    expect(payloadPreview(Buffer.from('{"не":"json'))).toBe('{"не":"json');
  });

  it('управляющие коды и неразобранные байты заменены точкой', () => {
    expect(payloadPreview(Buffer.from([0x7b, 0xff, 0x00, 0x0a, 0x41]))).toBe('{···A');
  });

  it('пустое значение даёт пустой текст, длинное обрезается', () => {
    expect(payloadPreview(null)).toBe('');
    expect(payloadPreview(Buffer.alloc(PAYLOAD_PREVIEW_BYTES * 2, 0x61))).toHaveLength(
      PAYLOAD_PREVIEW_BYTES,
    );
  });
});
