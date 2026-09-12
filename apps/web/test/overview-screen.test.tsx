import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TopologyDevice, TopologyResponse } from '@fieldstream/contracts';
import { OverviewPage } from '../src/pages/OverviewPage.js';
import { queryKeys } from '../src/shared/api/query-keys.js';
import { useSessionStore } from '../src/shared/auth/session-store.js';
import { resetServerClock } from '../src/shared/time/serverClock.js';

const SERVER_TIME = '2026-02-11T10:00:00.000Z';

const device = (code: string, patch: Partial<TopologyDevice> = {}): TopologyDevice => ({
  code,
  label: `Камера ${code}`,
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
  stale: false,
  staleSince: '2026-02-11T09:59:50.000Z',
  ...patch,
});

const tree = (devices: readonly TopologyDevice[]): TopologyResponse => ({
  serverTime: SERVER_TIME,
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
              devices: [...devices],
            },
          ],
        },
      ],
    },
  ],
});

interface Replies {
  readonly devices?: readonly TopologyDevice[];
  readonly status?: number;
}

const stubFetch = (replies: Replies = {}): void => {
  Object.defineProperty(globalThis, 'fetch', {
    writable: true,
    value: vi.fn(() =>
      Promise.resolve({
        ok: (replies.status ?? 200) < 400,
        status: replies.status ?? 200,
        headers: new Headers({ 'x-server-time': SERVER_TIME }),
        json: () => Promise.resolve(tree(replies.devices ?? [device('RC-101'), device('RC-102')])),
      } as unknown as Response),
    ),
  });
};

let client: QueryClient;

const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <QueryClientProvider client={client}>
    <MemoryRouter>{children}</MemoryRouter>
  </QueryClientProvider>
);

const show = (): void => {
  render(<OverviewPage />, { wrapper });
};

beforeEach(() => {
  // Окно прокрутки меряется по offsetHeight, а jsdom всегда отдаёт ноль: без подмены
  // виртуализированный список не рисует ни одной строки
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1024);

  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  client.clear();
  resetServerClock();
});

describe('обзор стенда', () => {
  it('пока дерево едет, показывается заглушка', () => {
    stubFetch();
    show();

    expect(screen.getByRole('status', { name: 'Загружаем стенд' })).toBeInTheDocument();
  });

  it('недоступный шлюз объясняется словами и даёт повтор', async () => {
    stubFetch({ status: 503 });
    show();

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер недоступен');
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  it('пустой стенд объясняется, а не выглядит поломкой', async () => {
    stubFetch({ devices: [] });
    show();

    expect(await screen.findByText('Приборов на стенде нет')).toBeInTheDocument();
  });

  /** Сводка это первое, на что смотрят: числа должны сходиться с деревом под ней. */
  it('сводка считает приборы, связь и алармы', async () => {
    stubFetch({
      devices: [
        device('RC-101'),
        device('RC-102', { status: 'offline', reason: 'consecutive_errors' }),
        device('RC-103', { stale: true, activeAlarms: 2, worstSeverity: 'critical' }),
      ],
    });
    show();

    const summary = within(await screen.findByRole('group', { name: 'Сводка по стенду' }));

    expect(summary.getByText('приборов').previousSibling).toHaveTextContent('3');
    expect(summary.getByText('нет связи').previousSibling).toHaveTextContent('1');
    expect(summary.getByText('данные устарели').previousSibling).toHaveTextContent('1');
    expect(summary.getByText('активных алармов').previousSibling).toHaveTextContent('2');
  });

  /**
   * Статус машинный, и причина у него тоже машинная. Человеку нужны слова, иначе «не в
   * порядке» не отличить от «прибор выключили специально».
   */
  it('прибор без связи показан словами, а протухшее значение прочерком', async () => {
    stubFetch({
      devices: [
        device('RC-101', { status: 'offline', reason: 'consecutive_errors' }),
        device('RC-102', { stale: true }),
      ],
    });
    show();

    const tree = within(await screen.findByRole('region', { name: 'Дерево объектов площадки' }));

    expect(tree.getByText('нет связи')).toBeInTheDocument();
    expect(tree.getAllByText('–').length).toBeGreaterThan(0);
    expect(tree.getByText('данные устарели')).toBeInTheDocument();
  });

  /**
   * Провалившийся перезапрос оставляет данные в кэше, но переводит запрос в ошибку. Если
   * рисовать по этому признаку, один сетевой сбой убирает с экрана весь стенд, хотя числа
   * никуда не делись и просто перестали обновляться.
   */
  it('неудачный перезапрос оставляет стенд на экране и говорит об этом строкой', async () => {
    stubFetch();
    show();
    await screen.findByRole('region', { name: 'Дерево объектов площадки' });

    Object.defineProperty(globalThis, 'fetch', {
      writable: true,
      value: vi.fn(() => Promise.reject(new Error('сеть недоступна'))),
    });
    await client.refetchQueries({ queryKey: queryKeys.topology });

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('данные на экране могли устареть');
    });
    expect(screen.getByRole('region', { name: 'Дерево объектов площадки' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('прибор в дереве это ссылка на его экран', async () => {
    stubFetch();
    show();

    const link = await screen.findByRole('link', { name: 'RC-101' });

    expect(link).toHaveAttribute('href', '/device/RC-101');
  });

  /** Живое событие правит тот же кэш: дерево обновляется без повторного запроса к серверу. */
  it('живая правка кэша меняет дерево без похода в сеть', async () => {
    stubFetch();
    show();
    await screen.findByRole('link', { name: 'RC-101' });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    client.setQueryData<TopologyResponse>(queryKeys.topology, (current) =>
      current === undefined
        ? current
        : tree([device('RC-101', { status: 'offline', reason: 'stale' }), device('RC-102')]),
    );

    await waitFor(() => {
      const tree = within(screen.getByRole('region', { name: 'Дерево объектов площадки' }));
      expect(tree.getByText('нет связи')).toBeInTheDocument();
    });
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });
});
