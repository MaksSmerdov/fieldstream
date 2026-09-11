import { describe, expect, it } from 'vitest';
import { createKafkaClient } from '../src/producer.js';
import type { KafkaLog } from '../src/producer.js';

/** Логгер, которому нужен свой this, как у pino: оторванный от объекта метод на нём падает. */
class RecordingLog implements KafkaLog {
  public readonly entries: { level: string; message: string; fields: Record<string, unknown> }[] =
    [];

  public error(fields: Record<string, unknown>, message: string): void {
    this.entries.push({ level: 'error', message, fields });
  }

  public warn(fields: Record<string, unknown>, message: string): void {
    this.entries.push({ level: 'warn', message, fields });
  }

  public info(fields: Record<string, unknown>, message: string): void {
    this.entries.push({ level: 'info', message, fields });
  }

  public debug(fields: Record<string, unknown>, message: string): void {
    this.entries.push({ level: 'debug', message, fields });
  }
}

describe('логи kafkajs', () => {
  it('уходят в логгер сервиса с сохранением уровня и контекста', () => {
    const log = new RecordingLog();
    const kafka = createKafkaClient({ clientId: 'test', brokers: ['localhost:1'], log });

    kafka.logger().error('брокер недоступен', { broker: 'localhost:1' });
    kafka.logger().warn('повтор', { retry: 2 });

    expect(log.entries).toEqual([
      {
        level: 'error',
        message: 'брокер недоступен',
        fields: expect.objectContaining({ broker: 'localhost:1' }) as unknown,
      },
      {
        level: 'warn',
        message: 'повтор',
        fields: expect.objectContaining({ retry: 2 }) as unknown,
      },
    ]);
  });

  it('отладочные сообщения ниже порога WARN не пишутся', () => {
    const log = new RecordingLog();
    createKafkaClient({ clientId: 'test', brokers: ['localhost:1'], log })
      .logger()
      .info('шум');

    expect(log.entries).toEqual([]);
  });
});
