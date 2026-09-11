import { describe, expect, it } from 'vitest';
import { KAFKA_HEADERS, TOPICS } from '@fieldstream/contracts';
import { toDlqMessage } from './dlq.js';

const ORIGIN = {
  topic: 'fieldstream.telemetry.raw.v1',
  partition: 3,
  offset: '1842',
  timestamp: '1789135000000',
  key: Buffer.from('RC-104'),
  value: Buffer.from([0x7b, 0xff, 0x00]),
  headers: { [KAFKA_HEADERS.traceId]: Buffer.from('0123456789abcdef') },
};

const FAILURE = {
  errorClass: 'invalid_json',
  error: 'Unexpected token',
  consumerGroup: 'fs-processor',
  attempt: 1,
  firstFailedAt: '2026-09-11T10:00:00.000Z',
};

describe('сообщение для очереди недоставленных', () => {
  it('несёт исходные байты и исходный ключ без попытки разбора', () => {
    const message = toDlqMessage(TOPICS.telemetryRawDlq, ORIGIN, FAILURE, 'stream-processor');

    expect(message.topic).toBe('fieldstream.telemetry.raw.dlq.v1');
    expect(message.key?.equals(ORIGIN.key)).toBe(true);
    expect(message.value?.equals(ORIGIN.value)).toBe(true);
  });

  it('вся диагностика в заголовках, исходные заголовки сохранены', () => {
    const { headers } = toDlqMessage(TOPICS.telemetryRawDlq, ORIGIN, FAILURE, 'stream-processor');

    expect(headers).toMatchObject({
      [KAFKA_HEADERS.dlqOriginTopic]: 'fieldstream.telemetry.raw.v1',
      [KAFKA_HEADERS.dlqOriginPartition]: '3',
      [KAFKA_HEADERS.dlqOriginOffset]: '1842',
      [KAFKA_HEADERS.dlqErrorClass]: 'invalid_json',
      [KAFKA_HEADERS.dlqAttempt]: '1',
      [KAFKA_HEADERS.dlqConsumerGroup]: 'fs-processor',
    });
    expect(headers[KAFKA_HEADERS.traceId]).toEqual(Buffer.from('0123456789abcdef'));
  });

  it('в очередь пишет только её владелец', () => {
    expect(() => toDlqMessage(TOPICS.telemetryRawDlq, ORIGIN, FAILURE, 'edge-collector')).toThrow(
      'пишет только stream-processor',
    );
  });
});
