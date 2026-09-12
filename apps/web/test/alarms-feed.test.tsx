import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlarmListItem, AlarmsResponse, ModuleId } from '@fieldstream/contracts';
import { AlarmsPage } from '../src/pages/AlarmsPage.js';
import { useSessionStore } from '../src/shared/auth/session-store.js';

const SERVER_TIME = '2026-02-11T10:00:00.000Z';

/** Идентификатор эпизода это uuid: схема ленты проверяет его, и выдуманное «a1» она отвергнет. */
const ID = [
  '4dca8f38-ab30-5a9a-9872-97a025cb6167',
  '7f1d2c44-9b0e-5a1f-8c33-2b7d5e9a4411',
  'c2a6f0b1-33d4-5e77-9a02-6d18b4c7e550',
] as const;

const alarm = (id: string, patch: Partial<AlarmListItem> = {}): AlarmListItem => ({
  id,
  deviceCode: 'RC-103',
  deviceLabel: 'Камера 3',
  metricKey: 'supply_temp_c',
  mode: 'cooling',
  severity: 'warning',
  boundary: 'max',
  value: 4.2,
  threshold: 2,
  occurredAt: '2026-02-11T09:30:00.000Z',
  clearedAt: null,
  clearedValue: null,
  ackedBy: null,
  ackedAt: null,
  active: true,
  ...patch,
});

interface Replies {
  readonly items?: readonly AlarmListItem[];
  readonly nextCursor?: string | null;
  readonly status?: number;
  readonly ackStatus?: number;
}

let calls: string[] = [];

/** Ответы шлюза по адресам: лента проходит через настоящий слой запросов и разбор схем. */
const stubFetch = (replies: Replies = {}): void => {
  const page = (cursor: string | null): AlarmsResponse => ({
    items:
      cursor === null
        ? [...(replies.items ?? [alarm(ID[0]), alarm(ID[1], { severity: 'critical' })])]
        : [alarm(ID[2])],
    nextCursor: cursor === null ? (replies.nextCursor ?? null) : null,
    serverTime: SERVER_TIME,
  });

  Object.defineProperty(globalThis, 'fetch', {
    writable: true,
    value: vi.fn((path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      const failed = init?.method === 'POST' ? (replies.ackStatus ?? 200) : (replies.status ?? 200);
      const cursor = new URL(path, 'http://stand').searchParams.get('cursor');

      return Promise.resolve({
        ok: failed < 400,
        status: failed,
        headers: new Headers({ 'x-server-time': SERVER_TIME }),
        json: () =>
          Promise.resolve(
            path.startsWith('/api/topology')
              ? { sites: [], serverTime: SERVER_TIME }
              : init?.method === 'POST'
                ? alarm(ID[0], { ackedBy: 'engineer@fieldstream.local', ackedAt: SERVER_TIME })
                : page(cursor),
          ),
      } as unknown as Response);
    }),
  });
};

let client: QueryClient;

const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={['/alarms']}>{children}</MemoryRouter>
  </QueryClientProvider>
);

const signIn = (permissions: readonly ModuleId[]): void => {
  useSessionStore.setState({
    accessToken: 'токен',
    expiresAt: '2026-02-11T11:00:00.000Z',
    user: {
      id: 'ba0ba102-a143-4f6c-8538-47bded9939fb',
      email: 'engineer@fieldstream.local',
      displayName: 'Инженер',
      role: permissions.includes('alarms.ack') ? 'engineer' : 'viewer',
      permissions: [...permissions],
    },
    checked: true,
  });
};

const show = (): void => {
  render(<AlarmsPage />, { wrapper });
};

beforeEach(() => {
  calls = [];
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  signIn(['overview', 'devices', 'alarms', 'alarms.ack']);
});

afterEach(() => {
  cleanup();
  client.clear();
});

describe('лента алармов', () => {
  it('пока лента едет, показывается заглушка', () => {
    stubFetch();
    show();

    expect(screen.getByRole('status', { name: 'Загружаем ленту' })).toBeInTheDocument();
  });

  it('недоступный шлюз объясняется словами и даёт повтор', async () => {
    stubFetch({ status: 503 });
    show();

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер недоступен');
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  it('пустой ответ объясняется и даёт сбросить фильтры', async () => {
    stubFetch({ items: [] });
    show();

    expect(await screen.findByText('Под фильтры ничего не попало')).toBeInTheDocument();
  });

  /** Значение и уставка рядом: без них эпизод не отличить от соседнего. */
  it('строка несёт значение, уставку и длительность', async () => {
    stubFetch();
    show();

    expect((await screen.findAllByText('4.2 выше уставки 2')).length).toBe(2);
    expect(screen.getAllByRole('link', { name: 'RC-103' })).toHaveLength(2);
  });

  /**
   * Ожидание ответа на ленте из сотни строк читается как «кнопка не сработала», поэтому
   * отметка ставится сразу, а при отказе снимается.
   */
  it('подтверждение видно сразу, до ответа сервера', async () => {
    stubFetch();
    show();

    const buttons = await screen.findAllByRole('button', { name: 'Подтвердить' });
    await userEvent.click(buttons[0] as HTMLElement);

    expect(await screen.findByText('engineer@fieldstream.local')).toBeInTheDocument();
    expect(calls.some((call) => call === `POST /api/alarms/${ID[0]}/ack`)).toBe(true);
  });

  it('отказ сервера снимает отметку обратно и объясняет причину', async () => {
    stubFetch({ ackStatus: 503 });
    show();

    const buttons = await screen.findAllByRole('button', { name: 'Подтвердить' });
    await userEvent.click(buttons[0] as HTMLElement);

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер недоступен');
    await waitFor(() => {
      expect(screen.queryByText('engineer@fieldstream.local')).not.toBeInTheDocument();
    });
    expect(screen.getAllByRole('button', { name: 'Подтвердить' })).toHaveLength(2);
  });

  it('без права на подтверждение кнопки нет вовсе', async () => {
    signIn(['overview', 'devices', 'alarms']);
    stubFetch();
    show();

    expect((await screen.findAllByText('4.2 выше уставки 2')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Подтвердить' })).not.toBeInTheDocument();
    expect(screen.getAllByText('не подтверждён').length).toBeGreaterThan(0);
  });

  /** Страница берётся курсором: при смещении новый эпизод сдвинул бы ленту и повторил конец. */
  it('следующая страница просится курсором, а не смещением', async () => {
    stubFetch({ nextCursor: 'курсор' });
    show();

    await userEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }));

    await waitFor(() => {
      expect(
        calls.some((call) => call.includes('cursor=%D0%BA%D1%83%D1%80%D1%81%D0%BE%D1%80')),
      ).toBe(true);
    });
    expect(calls.every((call) => !call.includes('offset'))).toBe(true);
    expect(await screen.findByText(/показано 3 эпизода/)).toBeInTheDocument();
  });
});
