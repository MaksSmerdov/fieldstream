import { describe, expect, it } from 'vitest';
import { createFakeClock } from '@fieldstream/domain';
import { createLogThrottle } from './throttle.js';

describe('подавление дублей в логе', () => {
  it('одинаковая запись проходит раз в 15 секунд и сообщает число скрытых повторов', () => {
    const clock = createFakeClock(0);
    const throttle = createLogThrottle(clock);

    expect(throttle('L1:RC-101:timeout')).toEqual({ pass: true, suppressed: 0 });
    clock.advance(10_000);
    expect(throttle('L1:RC-101:timeout')).toEqual({ pass: false, suppressed: 1 });
    clock.advance(4_999);
    expect(throttle('L1:RC-101:timeout')).toEqual({ pass: false, suppressed: 2 });
    clock.advance(1);
    expect(throttle('L1:RC-101:timeout')).toEqual({ pass: true, suppressed: 2 });
  });

  it('разные ключи не мешают друг другу', () => {
    const throttle = createLogThrottle(createFakeClock(0));

    expect(throttle('L1:RC-101:timeout').pass).toBe(true);
    expect(throttle('L1:RC-102:timeout').pass).toBe(true);
    expect(throttle('L1:RC-101:crc').pass).toBe(true);
  });
});
