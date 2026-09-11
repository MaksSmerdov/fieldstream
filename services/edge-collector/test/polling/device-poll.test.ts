import { describe, expect, it } from 'vitest';
import { buildDeviceReadPlan, pm3PhaseProfile } from '@fieldstream/device-profiles';
import type { RegisterSpan } from '@fieldstream/device-profiles';
import { createFakeClock } from '@fieldstream/domain';
import { pollDevice } from '../../src/polling/device-poll.js';

const plan = buildDeviceReadPlan(pm3PhaseProfile);

describe('опрос прибора', () => {
  it('читает все блоки плана и отдаёт их в порядке плана', async () => {
    const clock = createFakeClock(0);
    const asked: RegisterSpan[] = [];
    const result = await pollDevice(
      (_slaveId, span) => {
        asked.push(span);
        clock.advance(10);
        return Promise.resolve(Array.from({ length: span.registerCount }, () => 7));
      },
      4,
      plan,
      clock,
    );

    expect(result.ok).toBe(true);
    expect(result.requestCount).toBe(plan.requestCount);
    expect(result.durationMs).toBe(10 * plan.requestCount);
    expect(result.blocks.map((block) => block.startAddress)).toEqual(
      plan.blocks.map((block) => block.startAddress),
    );
    expect(asked).toHaveLength(plan.requestCount);
  });

  it('первая ошибка прекращает опрос прибора и классифицируется', async () => {
    let calls = 0;
    const result = await pollDevice(
      () => {
        calls += 1;
        return calls === 2
          ? Promise.reject(Object.assign(new Error('Timed out'), { errno: 'ETIMEDOUT' }))
          : Promise.resolve([1, 2, 3]);
      },
      4,
      plan,
      createFakeClock(0),
    );

    expect(result).toMatchObject({ ok: false, errorKind: 'timeout', requestCount: 2 });
    expect(result.blocks).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
