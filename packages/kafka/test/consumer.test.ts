import { describe, expect, it } from 'vitest';
import type { EachBatchPayload, Offsets } from 'kafkajs';
import { KAFKA_HEADERS, TOPICS } from '@fieldstream/contracts';
import { commitThrough, decodeMessage, headerText, topicMajor } from '../src/consumer.js';

const RAW = {
  schema: 'telemetry.raw',
  v: 1,
  ts: '2026-09-11T10:00:00.000Z',
  siteCode: 'SITE-A',
  gatewayCode: 'GW-01',
  lineCode: 'L1',
  deviceCode: 'RC-101',
  slaveId: 1,
  profileKey: 'rc-2000',
  profileVersion: 1,
  blocks: [{ registerType: 'input', startAddress: 0, words: [65_350, 12] }],
  cycleMs: 42,
  traceId: '0123456789abcdef',
};

const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8');

describe('разбор сообщения на входе', () => {
  it('корректный кадр проходит схему своего топика', () => {
    const decoded = decodeMessage(TOPICS.telemetryRaw, bytes(RAW), {
      [KAFKA_HEADERS.schemaVersion]: '1',
    });

    expect(decoded).toEqual({ ok: true, payload: RAW });
  });

  it('каждый вид отказа получает свой класс, а не общий «ошибка»', () => {
    expect(decodeMessage(TOPICS.telemetryRaw, null, undefined)).toMatchObject({
      ok: false,
      errorClass: 'empty',
    });
    expect(decodeMessage(TOPICS.telemetryRaw, Buffer.from('{не json'), undefined)).toMatchObject({
      ok: false,
      errorClass: 'invalid_json',
    });
    expect(
      decodeMessage(TOPICS.telemetryRaw, bytes({ ...RAW, slaveId: 999 }), undefined),
    ).toMatchObject({
      ok: false,
      errorClass: 'schema',
      error: expect.stringContaining('slaveId') as unknown,
    });
  });

  it('сообщение новой мажорной версии схемы не разбирается наугад', () => {
    const decoded = decodeMessage(TOPICS.telemetryRaw, bytes(RAW), {
      [KAFKA_HEADERS.schemaVersion]: Buffer.from('2'),
    });

    expect(decoded).toMatchObject({ ok: false, errorClass: 'schema_major_mismatch' });
  });
});

describe('вспомогательное', () => {
  it('заголовок читается строкой из строки, буфера или массива', () => {
    expect(headerText({ a: 'x', b: Buffer.from('y'), c: [Buffer.from('z')] }, 'a')).toBe('x');
    expect(headerText({ b: Buffer.from('y') }, 'b')).toBe('y');
    expect(headerText({ c: [Buffer.from('z')] }, 'c')).toBe('z');
    expect(headerText(undefined, 'a')).toBeNull();
  });

  it('мажорная версия схемы берётся из имени топика', () => {
    expect(topicMajor('fieldstream.telemetry.raw.v1')).toBe(1);
    expect(topicMajor('fieldstream.telemetry.raw.v12')).toBe(12);
  });
});

describe('подтверждение пачки', () => {
  it('коммитит явно и следующую позицию чтения, а не последнее прочитанное смещение', async () => {
    const resolved: string[] = [];
    const committed: (Offsets | undefined)[] = [];
    const payload = {
      batch: { topic: 'fieldstream.telemetry.raw.v1', partition: 4 },
      resolveOffset: (offset: string) => {
        resolved.push(offset);
      },
      commitOffsetsIfNecessary: (offsets?: Offsets) => {
        committed.push(offsets);
        return Promise.resolve();
      },
    } as unknown as EachBatchPayload;

    await commitThrough(payload, '9007199254740993');

    expect(resolved).toEqual(['9007199254740993']);
    expect(committed).toEqual([
      {
        topics: [
          {
            topic: 'fieldstream.telemetry.raw.v1',
            partitions: [{ partition: 4, offset: '9007199254740994' }],
          },
        ],
      },
    ]);
  });
});
