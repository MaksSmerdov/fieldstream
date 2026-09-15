import { describe, expect, it } from 'vitest';
import { KAFKA_HEADERS, TOPICS } from '@fieldstream/contracts';
import { readDlqHistory, toDlqMessage, toRedriveMessage } from '../src/dlq.js';

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

const SOURCE = {
  id: '42',
  key: Buffer.from('RC-104'),
  value: Buffer.from([0x7b, 0xff, 0x00]),
  headers: {
    [KAFKA_HEADERS.traceId]: '0123456789abcdef',
    [KAFKA_HEADERS.dlqAttempt]: '1',
  },
  attempts: 2,
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

describe('сообщение повторной подачи', () => {
  it('идёт в исходный топик с исходными ключом, байтами и заголовками', () => {
    const message = toRedriveMessage(TOPICS.telemetryRaw, SOURCE, 'stream-processor');

    expect(message.topic).toBe('fieldstream.telemetry.raw.v1');
    expect(message.key?.equals(SOURCE.key)).toBe(true);
    expect(message.value?.equals(SOURCE.value)).toBe(true);
    expect(message.headers[KAFKA_HEADERS.traceId]).toBe('0123456789abcdef');
  });

  it('счёт неудач и момент первой берутся из базы, а не из старых заголовков', () => {
    const { headers } = toRedriveMessage(TOPICS.telemetryRaw, SOURCE, 'stream-processor');

    expect(headers[KAFKA_HEADERS.dlqAttempt]).toBe('2');
    expect(headers[KAFKA_HEADERS.dlqFirstFailedAt]).toBe('2026-09-11T10:00:00.000Z');
  });

  it('несёт номер строки очереди, из которой подано, и заголовки читаются обратно', () => {
    const { headers } = toRedriveMessage(TOPICS.telemetryRaw, SOURCE, 'stream-processor');

    expect(headers[KAFKA_HEADERS.dlqRedriveOf]).toBe('42');
    expect(readDlqHistory(headers)).toEqual({
      attempts: 2,
      firstFailedAt: '2026-09-11T10:00:00.000Z',
      redriveOf: '42',
    });
  });

  it('подаёт только объявленный в манифесте сервис, даже владелец топика не может', () => {
    expect(() => toRedriveMessage(TOPICS.telemetryRaw, SOURCE, 'edge-collector')).toThrow(
      'повторно подаёт только stream-processor',
    );
    expect(() => toRedriveMessage(TOPICS.telemetryReadings, SOURCE, 'stream-processor')).toThrow(
      'повторная подача не разрешена',
    );
  });
});

describe('история неудач входящего сообщения', () => {
  it('без заголовков сообщение падает впервые', () => {
    expect(readDlqHistory(undefined)).toEqual({
      attempts: 0,
      firstFailedAt: null,
      redriveOf: null,
    });
    expect(readDlqHistory({})).toEqual({ attempts: 0, firstFailedAt: null, redriveOf: null });
  });

  it('заголовки прошлой подачи продолжают счёт', () => {
    expect(
      readDlqHistory({
        [KAFKA_HEADERS.dlqAttempt]: Buffer.from('2'),
        [KAFKA_HEADERS.dlqFirstFailedAt]: '2026-09-11T10:00:00.000Z',
      }),
    ).toEqual({ attempts: 2, firstFailedAt: '2026-09-11T10:00:00.000Z', redriveOf: null });
  });

  it('момент со смещением приводится к UTC', () => {
    expect(
      readDlqHistory({ [KAFKA_HEADERS.dlqFirstFailedAt]: '2026-09-11T13:00:00+03:00' })
        .firstFailedAt,
    ).toBe('2026-09-11T10:00:00.000Z');
  });

  it('испорченные заголовки не ломают счёт, а считаются отсутствующими', () => {
    expect(
      readDlqHistory({
        [KAFKA_HEADERS.dlqAttempt]: 'много',
        [KAFKA_HEADERS.dlqFirstFailedAt]: 'вчера',
      }),
    ).toEqual({ attempts: 0, firstFailedAt: null, redriveOf: null });
    expect(readDlqHistory({ [KAFKA_HEADERS.dlqAttempt]: '-3' }).attempts).toBe(0);
    expect(readDlqHistory({ [KAFKA_HEADERS.dlqAttempt]: '1.5' }).attempts).toBe(0);
  });

  it('то, что Date.parse принимает, а база нет, считается отсутствующим', () => {
    for (const text of [
      '1',
      '2026',
      '2026-09-11',
      '2026-09-11T10:00:00+99:99',
      '0000-01-01T00:00:00Z',
      '1969-12-31T23:59:59Z',
    ]) {
      expect(readDlqHistory({ [KAFKA_HEADERS.dlqFirstFailedAt]: text }).firstFailedAt).toBeNull();
    }
  });

  it('счёт попыток вне integer и сверх предела считается отсутствующим', () => {
    for (const text of ['2147483648', '9007199254740991', '1001', '01', ' 2', '1e3']) {
      expect(readDlqHistory({ [KAFKA_HEADERS.dlqAttempt]: text }).attempts).toBe(0);
    }
    expect(readDlqHistory({ [KAFKA_HEADERS.dlqAttempt]: '1000' }).attempts).toBe(1_000);
  });

  it('номер исходной строки принимается только числом без знака', () => {
    for (const text of ['0', '-1', '1; DROP', '12345678901234567890']) {
      expect(readDlqHistory({ [KAFKA_HEADERS.dlqRedriveOf]: text }).redriveOf).toBeNull();
    }
  });
});
