import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlarmsResponse, DeviceSnapshot, TopologyResponse } from '@fieldstream/contracts';
import { queryKeys } from '../src/shared/api/query-keys.js';
import { useSessionStore } from '../src/shared/auth/session-store.js';
import { useLiveStore } from '../src/shared/sse/live-store.js';
import { useLivePatch } from '../src/shared/sse/useLivePatch.js';

const PING_MS = 20_000;

/** Подменённый поток событий: тест сам решает, что и когда приходит в вкладку. */
class FakeEventSource {
  public static instances: FakeEventSource[] = [];
  public readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  public closed = false;

  public constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  public addEventListener(kind: string, listener: (event: MessageEvent<string>) => void): void {
    const list = this.listeners.get(kind) ?? [];
    list.push(listener);
    this.listeners.set(kind, list);
  }

  public close(): void {
    this.closed = true;
  }

  public emit(kind: string, data: unknown, id: string): void {
    const event = { data: JSON.stringify(data), lastEventId: id } as MessageEvent<string>;
    for (const listener of this.listeners.get(kind) ?? []) listener(event);
  }

  public open(): void {
    for (const listener of this.listeners.get('open') ?? []) {
      listener({ data: '', lastEventId: '' } as MessageEvent<string>);
    }
  }

  public static latest(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1);
    if (last === undefined) throw new Error('поток не открывался');
    return last;
  }
}

const tree = (): TopologyResponse => ({
  serverTime: '2026-02-11T10:00:00.000Z',
  sites: [
    {
      code: 'SITE-A',
      name: 'Площадка',
      timezone: 'UTC',
      gateways: [
        {
          code: 'GW-01',
          host: '127.0.0.1',
          lines: [
            {
              code: 'L1',
              baud: 9600,
              pollIntervalMs: 10_000,
              requestTimeoutMs: 600,
              planMode: 'merged',
              enabled: true,
              devices: [
                {
                  code: 'RC-101',
                  label: 'Контроллер RC-101',
                  profileKey: 'rc-2000',
                  profileVersion: 1,
                  slaveId: 1,
                  enabled: true,
                  status: 'online',
                  reason: 'ok',
                  mode: 'cooling',
                  since: '2026-02-11T09:00:00.000Z',
                  lastOkAt: '2026-02-11T09:59:50.000Z',
                  activeAlarms: 0,
                  worstSeverity: null,
                  stale: true,
                  staleSince: '2026-02-11T09:40:00.000Z',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

const deviceOf = (data: TopologyResponse | undefined) =>
  data?.sites[0]?.gateways[0]?.lines[0]?.devices[0];

let client: QueryClient;
let fetchSpy: ReturnType<typeof vi.fn>;

const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  Object.defineProperty(globalThis, 'EventSource', { writable: true, value: FakeEventSource });
  fetchSpy = vi.fn(() => Promise.reject(new Error('сетевого запроса быть не должно')));
  Object.defineProperty(globalThis, 'fetch', { writable: true, value: fetchSpy });

  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.topology, tree());
  useSessionStore.setState({
    accessToken: 'токен',
    expiresAt: '2026-02-11T11:00:00.000Z',
    user: {
      id: 'ba0ba102-a143-4f6c-8538-47bded9939fb',
      email: 'engineer@fieldstream.local',
      displayName: 'Инженер',
      role: 'engineer',
      permissions: ['overview', 'devices', 'alarms'],
    },
    checked: true,
  });
  useLiveStore.setState({
    status: 'connecting',
    lastEventId: null,
    lastFrameAtMs: null,
    epoch: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('живой канал', () => {
  it('подписка едет ключами и токеном, соединение одно', () => {
    renderHook(
      () => {
        useLivePatch(['site:SITE-A']);
      },
      { wrapper },
    );

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.latest().url).toContain('keys=site%3ASITE-A');
    expect(FakeEventSource.latest().url).toContain('access_token=');
  });

  /**
   * Главная причина, по которой живые данные не инвалидируют кэш: показание уже пришло
   * событием, и спрашивать его снова у сервера незачем.
   */
  it('показание правит кэш и не ходит в сеть', () => {
    renderHook(
      () => {
        useLivePatch(['site:SITE-A']);
      },
      { wrapper },
    );
    const source = FakeEventSource.latest();
    source.open();

    source.emit(
      'hello',
      { serverTime: '2026-02-11T10:00:00.000Z', epoch: 7, pingMs: PING_MS },
      '7:1',
    );
    source.emit(
      'reading',
      {
        deviceCode: 'RC-101',
        ts: '2026-02-11T10:00:05.000Z',
        mode: 'defrost',
        quality: 'ok',
        metrics: { supply_temp_c: -12.5 },
      },
      '7:2',
    );

    const device = deviceOf(client.getQueryData<TopologyResponse>(queryKeys.topology));
    expect(device?.stale).toBe(false);
    expect(device?.mode).toBe('defrost');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('повтор события с тем же номером ничего не меняет второй раз', () => {
    renderHook(
      () => {
        useLivePatch([]);
      },
      { wrapper },
    );
    const source = FakeEventSource.latest();
    source.open();
    source.emit(
      'hello',
      { serverTime: '2026-02-11T10:00:00.000Z', epoch: 7, pingMs: PING_MS },
      '7:1',
    );

    const alarm = {
      alarmId: '4dca8f38-ab30-5a9a-9872-97a025cb6167',
      dedupeKey: 'RC-101|supply_temp_c|cooling|2026-02-11T10:00:00.000Z',
      deviceCode: 'RC-101',
      metricKey: 'supply_temp_c',
      mode: 'cooling',
      state: 'raised',
      severity: 'warning',
      value: 4.2,
      threshold: 2,
      boundary: 'max',
      occurredAt: '2026-02-11T10:00:00.000Z',
    };
    client.setQueryData<InfiniteData<AlarmsResponse>>(queryKeys.alarms({ state: 'any' }), {
      pageParams: [null],
      pages: [{ items: [], nextCursor: null, serverTime: '2026-02-11T10:00:00.000Z' }],
    });

    source.emit('alarm', alarm, '7:3');
    source.emit('alarm', alarm, '7:3');

    const feed = client.getQueryData<InfiniteData<AlarmsResponse>>(
      queryKeys.alarms({ state: 'any' }),
    );
    expect(feed?.pages[0]?.items).toHaveLength(1);
    expect(deviceOf(client.getQueryData<TopologyResponse>(queryKeys.topology))?.activeAlarms).toBe(
      1,
    );
  });

  /**
   * У каждой открытой ленты свои фильтры, и они лежат прямо в ключе кэша. Снятый эпизод
   * обязан уйти из ленты незакрытых, а чужой прибор не должен появиться в ленте,
   * отфильтрованной по своему: иначе на экране появляются строки, которых там быть не может.
   */
  it('живой аларм попадает только в те ленты, под фильтры которых он подходит', () => {
    renderHook(
      () => {
        useLivePatch([]);
      },
      { wrapper },
    );
    const source = FakeEventSource.latest();
    source.open();
    source.emit(
      'hello',
      { serverTime: '2026-02-11T10:00:00.000Z', epoch: 7, pingMs: PING_MS },
      '7:1',
    );

    const empty = { items: [], nextCursor: null, serverTime: '2026-02-11T10:00:00.000Z' };
    const pageOf = (key: readonly unknown[]): void => {
      client.setQueryData<InfiniteData<AlarmsResponse>>(key, {
        pageParams: [null],
        pages: [{ ...empty }],
      });
    };
    pageOf(queryKeys.alarms({ state: 'active' }));
    pageOf(queryKeys.alarms({ state: 'cleared' }));
    pageOf(queryKeys.alarms({ device: 'RC-102' }));

    const raised = {
      alarmId: '4dca8f38-ab30-5a9a-9872-97a025cb6167',
      dedupeKey: 'RC-101|supply_temp_c|cooling|2026-02-11T10:00:00.000Z',
      deviceCode: 'RC-101',
      metricKey: 'supply_temp_c',
      mode: 'cooling',
      state: 'raised',
      severity: 'warning',
      value: 4.2,
      threshold: 2,
      boundary: 'max',
      occurredAt: '2026-02-11T10:00:00.000Z',
    };

    source.emit('alarm', raised, '7:2');

    const itemsOf = (key: readonly unknown[]): number =>
      client.getQueryData<InfiniteData<AlarmsResponse>>(key)?.pages[0]?.items.length ?? -1;

    expect(itemsOf(queryKeys.alarms({ state: 'active' }))).toBe(1);
    expect(itemsOf(queryKeys.alarms({ state: 'cleared' }))).toBe(0);
    expect(itemsOf(queryKeys.alarms({ device: 'RC-102' }))).toBe(0);

    source.emit('alarm', { ...raised, state: 'cleared' }, '7:3');

    expect(itemsOf(queryKeys.alarms({ state: 'active' }))).toBe(0);
  });

  /** Чип «активных алармов» на экране прибора берётся из снимка, а не из дерева объектов. */
  it('живой аларм правит счётчик в снимке прибора', () => {
    client.setQueryData(queryKeys.snapshot('RC-101'), {
      deviceCode: 'RC-101',
      label: 'Камера',
      lineCode: 'L1',
      siteCode: 'SITE-A',
      profileKey: 'rc-2000',
      profileVersion: 1,
      status: 'online',
      reason: 'ok',
      mode: 'cooling',
      since: null,
      lastOkAt: null,
      consecutiveErrors: 0,
      stale: false,
      ts: null,
      metrics: [],
      activeAlarms: 0,
      serverTime: '2026-02-11T10:00:00.000Z',
    });
    renderHook(
      () => {
        useLivePatch([]);
      },
      { wrapper },
    );
    const source = FakeEventSource.latest();
    source.open();

    source.emit(
      'alarm',
      {
        alarmId: '4dca8f38-ab30-5a9a-9872-97a025cb6167',
        dedupeKey: 'RC-101|supply_temp_c|cooling|2026-02-11T10:00:00.000Z',
        deviceCode: 'RC-101',
        metricKey: 'supply_temp_c',
        mode: 'cooling',
        state: 'raised',
        severity: 'warning',
        value: 4.2,
        threshold: 2,
        boundary: 'max',
        occurredAt: '2026-02-11T10:00:00.000Z',
      },
      '7:4',
    );

    expect(client.getQueryData<DeviceSnapshot>(queryKeys.snapshot('RC-101'))?.activeAlarms).toBe(1);
  });

  /** Сервер замолчал, но браузер считает соединение живым: своё переоткрытие обязательно. */
  it('сторож тишины переоткрывает поток и просит продолжить с последнего номера', () => {
    renderHook(
      () => {
        useLivePatch([]);
      },
      { wrapper },
    );
    const first = FakeEventSource.latest();
    first.open();
    first.emit(
      'hello',
      { serverTime: '2026-02-11T10:00:00.000Z', epoch: 7, pingMs: PING_MS },
      '7:9',
    );

    vi.advanceTimersByTime(PING_MS * 3 + 100);

    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.latest().url).toContain('last_event_id=7%3A9');
    expect(useLiveStore.getState().status).toBe('offline');
  });

  it('требование перечитать всё поднимает счётчик и обновляет данные из сети', () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    renderHook(
      () => {
        useLivePatch([]);
      },
      { wrapper },
    );
    const source = FakeEventSource.latest();
    source.open();

    source.emit(
      'resync',
      { reason: 'unknown_epoch', serverTime: '2026-02-11T10:00:00.000Z' },
      '7:1',
    );

    expect(useLiveStore.getState().resyncCount).toBe(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
