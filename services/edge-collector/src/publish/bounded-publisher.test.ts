import { describe, expect, it } from 'vitest';
import type { OutgoingMessage } from '@fieldstream/kafka';
import { createBoundedPublisher } from './bounded-publisher.js';
import type { BoundedPublisherOptions } from './bounded-publisher.js';

const message = (key: string): OutgoingMessage => ({
  topic: 'fieldstream.telemetry.raw.v1',
  key,
  value: '{}',
  headers: {},
});

const keysOf = (batches: readonly (readonly OutgoingMessage[])[]): string[][] =>
  batches.map((batch) => batch.map((item) => item.key));

const BASE: BoundedPublisherOptions = {
  capacity: 10,
  batchSize: 5,
  retryDelayMs: 0,
  send: () => Promise.resolve(),
  onDrop: () => undefined,
  onError: () => undefined,
  now: () => 0,
};

describe('буфер отправки', () => {
  it('отправляет пачками в исходном порядке', async () => {
    const sent: (readonly OutgoingMessage[])[] = [];
    const publisher = createBoundedPublisher({
      ...BASE,
      batchSize: 2,
      send: (batch) => {
        sent.push(batch);
        return Promise.resolve();
      },
    });

    for (const key of ['a', 'b', 'c', 'd', 'e']) publisher.enqueue(message(key));
    await publisher.drain();

    expect(keysOf(sent)).toEqual([['a'], ['b', 'c'], ['d', 'e']]);
    expect(publisher.size()).toBe(0);
  });

  it('когда брокер не отвечает, буфер держит ёмкость и отбрасывает самые старые', () => {
    const drops: number[] = [];
    const publisher = createBoundedPublisher({
      ...BASE,
      capacity: 3,
      batchSize: 2,
      send: () => new Promise<void>(() => undefined),
      onDrop: (count) => drops.push(count),
    });

    for (const key of ['1', '2', '3', '4', '5', '6']) publisher.enqueue(message(key));

    expect(publisher.size()).toBe(3);
    expect(publisher.dropped()).toBe(2);
    expect(drops).toEqual([1, 1]);
  });

  it('после ошибки отправки пачка уходит повторно и порядок сохраняется', async () => {
    const sent: (readonly OutgoingMessage[])[] = [];
    const errors: unknown[] = [];
    let failures = 1;
    const publisher = createBoundedPublisher({
      ...BASE,
      send: (batch) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error('брокер недоступен'));
        }
        sent.push(batch);
        return Promise.resolve();
      },
      onError: (error) => errors.push(error),
      sleep: () => Promise.resolve(),
    });

    publisher.enqueue(message('a'));
    publisher.enqueue(message('b'));
    await publisher.drain();

    expect(errors).toHaveLength(1);
    expect(keysOf(sent).flat()).toEqual(['a', 'b']);
  });

  it('возраст самого старого неотправленного растёт, пока брокер молчит, и обнуляется после отправки', async () => {
    let now = 0;
    let hang = true;
    let release: () => void = () => undefined;
    const publisher = createBoundedPublisher({
      ...BASE,
      batchSize: 1,
      now: () => now,
      send: () =>
        hang
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : Promise.resolve(),
    });

    publisher.enqueue(message('a'));
    now = 5_000;
    publisher.enqueue(message('b'));
    now = 20_000;
    expect(publisher.oldestAgeMs()).toBe(20_000);

    hang = false;
    release();
    await publisher.drain();

    expect(publisher.oldestAgeMs()).toBe(0);
  });

  it('после закрытия новые сообщения больше не отправляются', async () => {
    const sent: string[] = [];
    const publisher = createBoundedPublisher({
      ...BASE,
      send: (batch) => {
        sent.push(...batch.map((item) => item.key));
        return Promise.resolve();
      },
    });

    publisher.close();
    publisher.enqueue(message('late'));
    await publisher.drain();

    expect(sent).toEqual([]);
    expect(publisher.size()).toBe(1);
  });
});
