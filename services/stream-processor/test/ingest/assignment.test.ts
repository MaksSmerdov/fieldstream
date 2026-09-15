import { describe, expect, it } from 'vitest';
import { TOPICS } from '@fieldstream/contracts';
import { DEMO_STAND } from '@fieldstream/device-profiles';
import { partitionForKey } from '@fieldstream/kafka';
import { createHandovers, handoverOf, ownedDevices } from '../../src/ingest/assignment.js';
import type { Handovers } from '../../src/ingest/assignment.js';

const CODES = DEMO_STAND.devices.map((device) => device.code);
const EVEN = [...ownedDevices(CODES, [0, 2, 4])].sort();
const ODD = [...ownedDevices(CODES, [1, 3, 5])].sort();

interface Recorder {
  readonly handovers: Handovers;
  readonly released: string[][];
  readonly adopted: string[][];
}

/** Очередь переездов, которая запоминает шаги. Восстановление новых приборов ждёт gate. */
const recorder = (gate: Promise<void> = Promise.resolve()): Recorder => {
  const released: string[][] = [];
  const adopted: string[][] = [];
  const handovers = createHandovers({
    codes: () => CODES,
    release: (deviceCodes) => {
      released.push([...deviceCodes].sort());
    },
    adopt: async (deviceCodes) => {
      if (deviceCodes.length === 0) return;
      adopted.push([...deviceCodes].sort());
      await gate;
    },
    settled: () => undefined,
    failed: () => undefined,
  });
  return { handovers, released, adopted };
};

/** Даёт отработать всему, что уже стоит в очереди событий. */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('владение приборами по назначению', () => {
  it('все партиции дают весь стенд, без партиций своего нет ничего', () => {
    expect(ownedDevices(CODES, [0, 1, 2, 3, 4, 5]).size).toBe(CODES.length);
    expect(ownedDevices(CODES, []).size).toBe(0);
  });

  it('две половины партиций делят приборы без пересечений, по ключу продюсера', () => {
    const even = ownedDevices(CODES, [0, 2, 4]);
    const odd = ownedDevices(CODES, [5, 3, 1]);

    expect([...even].filter((code) => odd.has(code))).toEqual([]);
    expect(even.size + odd.size).toBe(CODES.length);
    expect(
      [...odd].every((code) => partitionForKey(code, TOPICS.telemetryRaw.partitions) % 2 === 1),
    ).toBe(true);
  });

  it('разница назначений: отобранные уходят, новые приходят, общие не трогаются', () => {
    expect(handoverOf(new Set(['RC-101', 'RC-102']), new Set(['RC-102', 'PM-201']))).toEqual({
      released: ['RC-101'],
      adopted: ['PM-201'],
    });
    expect(handoverOf(new Set(), new Set(['RC-101']))).toEqual({
      released: [],
      adopted: ['RC-101'],
    });
  });
});

describe('очередь переездов', () => {
  it('пачка ждёт, пока восстановление новых приборов не закончится', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { handovers } = recorder(gate);
    let processed = false;

    void handovers.assign('m1', [0, 2, 4]);
    const batch = handovers.ready().then(() => {
      processed = true;
    });
    await flush();

    expect(processed).toBe(false);
    expect(handovers.settling()).toBe(true);
    expect(handovers.ownership()).toBeNull();

    open();
    await batch;

    expect(processed).toBe(true);
    expect(handovers.settling()).toBe(false);
    expect([...(handovers.ownership()?.devices ?? [])].sort()).toEqual(EVEN);
  });

  it('падение потребителя отдаёт всё, и та же раскладка после возвращения восстанавливается заново', async () => {
    const { handovers, released, adopted } = recorder();

    await handovers.assign('m1', [0, 2, 4]);
    await handovers.revoke();
    expect(handovers.ownership()).toBeNull();
    await handovers.assign('m1', [0, 2, 4]);

    expect(released).toEqual([EVEN]);
    expect(adopted).toEqual([EVEN, EVEN]);
  });

  it('возврат в группу под другим memberId с той же раскладкой тоже переезд', async () => {
    const { handovers, released, adopted } = recorder();

    await handovers.assign('m1', [1, 3, 5]);
    await handovers.assign('m2', [5, 3, 1]);

    expect(released).toEqual([ODD]);
    expect(adopted).toEqual([ODD, ODD]);
  });

  it('тот же участник сохраняет оставшиеся приборы, а ребаланс держит публикацию до назначения', async () => {
    const { handovers, released, adopted } = recorder();

    await handovers.assign('m1', [0, 1, 2, 3, 4, 5]);
    handovers.announce();
    expect(handovers.settling()).toBe(true);

    await handovers.assign('m1', [0, 2, 4]);

    expect(handovers.settling()).toBe(false);
    expect(released).toEqual([ODD]);
    expect(adopted).toEqual([[...CODES].sort()]);
    expect(handovers.ownership()?.partitions).toEqual([0, 2, 4]);
  });
});
