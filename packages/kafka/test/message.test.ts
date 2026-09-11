import { describe, expect, it } from 'vitest';
import { KAFKA_HEADERS, TOPICS } from '@fieldstream/contracts';
import type { PayloadOf } from '@fieldstream/contracts';
import { encodeMessage } from '../src/message.js';
import { groupByTopic } from '../src/producer.js';

const RAW: PayloadOf<'telemetryRaw'> = {
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

const OPTIONS = { producer: 'edge-collector', traceId: '0123456789abcdef' };

describe('encodeMessage', () => {
  it('ключ, тело и заголовки берутся из манифеста и самого сообщения', () => {
    const message = encodeMessage(TOPICS.telemetryRaw, RAW, OPTIONS);

    expect(message.topic).toBe('fieldstream.telemetry.raw.v1');
    expect(message.key).toBe('RC-101');
    expect(JSON.parse(message.value)).toEqual(RAW);
    expect(message.headers).toEqual({
      [KAFKA_HEADERS.schema]: 'telemetry.raw',
      [KAFKA_HEADERS.schemaVersion]: '1',
      [KAFKA_HEADERS.traceId]: '0123456789abcdef',
    });
  });

  it('в чужой топик писать нельзя', () => {
    expect(() =>
      encodeMessage(TOPICS.telemetryRaw, RAW, { ...OPTIONS, producer: 'stream-processor' }),
    ).toThrow('в топик fieldstream.telemetry.raw.v1 пишет только edge-collector');
  });

  it('сообщение, не прошедшее схему, падает у автора', () => {
    expect(() => encodeMessage(TOPICS.telemetryRaw, { ...RAW, blocks: [] }, OPTIONS)).toThrow();
  });
});

describe('groupByTopic', () => {
  it('раскладывает сообщения по топикам, сохраняя порядок внутри топика', () => {
    const first = encodeMessage(TOPICS.telemetryRaw, RAW, OPTIONS);
    const second = encodeMessage(TOPICS.telemetryRaw, { ...RAW, deviceCode: 'RC-102' }, OPTIONS);
    const cycle = encodeMessage(
      TOPICS.pollCycles,
      {
        schema: 'poll.cycle',
        v: 1,
        ts: RAW.ts,
        lineCode: 'L1',
        deviceCode: 'RC-101',
        ok: true,
        errorKind: null,
        durationMs: 42,
        requestCount: 4,
        planMode: 'merged',
        traceId: RAW.traceId,
      },
      OPTIONS,
    );

    const groups = groupByTopic([first, cycle, second]);

    expect(groups.map((group) => group.topic)).toEqual([
      'fieldstream.telemetry.raw.v1',
      'fieldstream.collector.cycles.v1',
    ]);
    expect(groups[0]?.messages.map((message) => message.key)).toEqual(['RC-101', 'RC-102']);
  });
});
