import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { loadOpenAlarmEpisodes } from '../../src/store/alarms.js';
import { loadDeviceStates, lockDeviceStateHandover } from '../../src/store/state.js';

/** Клиент, который запоминает параметры запросов и отдаёт заданные строки. */
const fakeClient = (rows: readonly Record<string, unknown>[]) => {
  const query = vi.fn<(sql: string, values: unknown[]) => Promise<{ rows: typeof rows }>>(() =>
    Promise.resolve({ rows }),
  );
  return { query, client: { query } as unknown as pg.ClientBase };
};

describe('последнее состояние приборов', () => {
  it('моменты базы отдаются строками ISO, пустой успех остаётся null', async () => {
    const { client, query } = fakeClient([
      {
        device_code: 'RC-101',
        status: 'online',
        reason: 'ok',
        since: new Date('2026-09-11T10:00:00.000Z'),
        mode: 'defrost',
        last_ok_at: new Date('2026-09-11T10:05:00.000Z'),
        consecutive_errors: 0,
      },
      {
        device_code: 'PM-201',
        status: 'unknown',
        reason: 'no_data',
        since: new Date('2026-09-11T09:00:00.000Z'),
        mode: 'cooling',
        last_ok_at: null,
        consecutive_errors: 2,
      },
    ]);

    await expect(loadDeviceStates(client, ['RC-101', 'PM-201'])).resolves.toEqual([
      {
        schema: 'device.state',
        v: 1,
        deviceCode: 'RC-101',
        status: 'online',
        reason: 'ok',
        since: '2026-09-11T10:00:00.000Z',
        mode: 'defrost',
        lastOkAt: '2026-09-11T10:05:00.000Z',
        consecutiveErrors: 0,
      },
      {
        schema: 'device.state',
        v: 1,
        deviceCode: 'PM-201',
        status: 'unknown',
        reason: 'no_data',
        since: '2026-09-11T09:00:00.000Z',
        mode: 'cooling',
        lastOkAt: null,
        consecutiveErrors: 2,
      },
    ]);
    expect(query.mock.calls[0]?.[1]).toEqual([['RC-101', 'PM-201']]);
  });

  it('пустой список приборов в базу не ходит', async () => {
    const { client, query } = fakeClient([]);

    await expect(loadDeviceStates(client, [])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('блокировка переезда состояния', () => {
  it('проверка здоровья берёт общую блокировку, новый владелец исключительную с пределом ожидания', async () => {
    const { client, query } = fakeClient([]);

    await lockDeviceStateHandover(client, 'publish');
    await lockDeviceStateHandover(client, 'adopt', 2_500);

    expect(query.mock.calls).toEqual([
      ['SELECT pg_advisory_xact_lock_shared(hashtext($1))', ['fieldstream.device-state.handover']],
      ["SELECT set_config('lock_timeout', $1, true)", ['2500ms']],
      ['SELECT pg_advisory_xact_lock(hashtext($1))', ['fieldstream.device-state.handover']],
    ]);
  });
});

describe('открытые эпизоды алармов', () => {
  it('без списка приборов фильтр не накладывается, со списком уходит массивом кодов', async () => {
    const { client, query } = fakeClient([]);

    await loadOpenAlarmEpisodes(client);
    await loadOpenAlarmEpisodes(client, ['RC-105']);

    expect(query.mock.calls.map((call) => call[1])).toEqual([[null], [['RC-105']]]);
  });
});
