import { describe, expect, it } from 'vitest';
import { simFaultRequestSchema } from '@fieldstream/contracts';
import type { SimFaultRequest, SimFaultRequestInput } from '@fieldstream/contracts';
import { createFakeClock } from '@fieldstream/domain';
import { createFaultBook } from '../../src/chaos/faults.js';

const request = (input: SimFaultRequestInput): SimFaultRequest =>
  simFaultRequestSchema.parse(input);

describe('журнал поломок', () => {
  it('поломка живёт ровно свой срок по реальным часам', () => {
    const clock = createFakeClock(0);
    const book = createFaultBook(clock);
    book.add(
      request({ targetKind: 'device', targetId: 'RC-101', kind: 'silent', ttlSec: 10 }),
      null,
    );

    clock.advance(9_999);
    expect(book.list()).toHaveLength(1);
    clock.advance(1);
    expect(book.list()).toEqual([]);
  });

  it('повтор того же вида на ту же цель продлевает поломку, а не копит', () => {
    const clock = createFakeClock(0);
    const book = createFaultBook(clock);
    book.add(request({ targetKind: 'line', targetId: 'L1', kind: 'stall', ttlSec: 10 }), null);
    clock.advance(5_000);
    const renewed = book.add(
      request({ targetKind: 'line', targetId: 'L1', kind: 'stall', ttlSec: 10 }),
      null,
    );

    expect(book.list()).toEqual([renewed]);
    expect(renewed.expiresAtMs).toBe(15_000);
  });

  it('на прибор действуют и его поломки, и поломки его линии', () => {
    const book = createFaultBook(createFakeClock(0));
    book.add(request({ targetKind: 'line', targetId: 'L1', kind: 'stall' }), null);
    book.add(request({ targetKind: 'device', targetId: 'RC-101', kind: 'crc' }), null);
    book.add(request({ targetKind: 'device', targetId: 'RC-102', kind: 'silent' }), null);
    book.add(request({ targetKind: 'line', targetId: 'L2', kind: 'offline' }), null);

    expect(book.affecting('L1', 'RC-101').map((fault) => fault.kind)).toEqual(['stall', 'crc']);
    expect(book.onLine('L2', 'offline')).toBe(true);
    expect(book.onLine('L1', 'offline')).toBe(false);
    expect(book.onDevice('RC-102', 'silent')).toBe(true);
  });

  it('код исключения хранится только у поломки exception', () => {
    const book = createFaultBook(createFakeClock(0));
    const exception = book.add(
      request({ targetKind: 'device', targetId: 'RC-101', kind: 'exception', exceptionCode: 11 }),
      null,
    );
    const silent = book.add(
      request({ targetKind: 'device', targetId: 'RC-101', kind: 'silent' }),
      null,
    );

    expect(exception.exceptionCode).toBe(11);
    expect(silent.exceptionCode).toBeNull();
  });

  it('clear снимает всё и сообщает, сколько было', () => {
    const book = createFaultBook(createFakeClock(0));
    book.add(request({ targetKind: 'device', targetId: 'RC-101', kind: 'silent' }), null);
    book.add(request({ targetKind: 'line', targetId: 'L3', kind: 'crc' }), null);

    expect(book.clear()).toBe(2);
    expect(book.list()).toEqual([]);
  });
});
