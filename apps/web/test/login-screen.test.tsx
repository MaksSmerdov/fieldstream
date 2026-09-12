import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootResponse } from '@fieldstream/contracts';
import { LoginPage } from '../src/pages/LoginPage.js';
import { useSessionStore } from '../src/shared/auth/session-store.js';

const SERVER_TIME = '2026-02-11T10:00:00.000Z';

const boot = (ready: boolean): BootResponse => ({
  ready,
  serverTime: SERVER_TIME,
  stages: [
    {
      stage: 'topology',
      title: 'Стенд перенесён в базу',
      status: 'done',
      progressPct: 100,
      detail: '24 прибора',
    },
    {
      stage: 'history',
      title: 'История засеяна',
      status: ready ? 'done' : 'running',
      progressPct: ready ? 100 : 40,
      detail: ready ? '7 суток истории' : 'графики за неделю появятся после засева',
    },
    {
      stage: 'live',
      title: 'Поток телеметрии идёт',
      status: ready ? 'done' : 'pending',
      progressPct: ready ? 100 : 0,
      detail: null,
    },
  ],
});

interface Replies {
  readonly loginStatus?: number;
  readonly ready?: boolean;
  readonly bootStatus?: number;
}

const stubFetch = (replies: Replies = {}): void => {
  Object.defineProperty(globalThis, 'fetch', {
    writable: true,
    value: vi.fn((path: string, init?: RequestInit) => {
      const login = init?.method === 'POST';
      const status = login ? (replies.loginStatus ?? 200) : (replies.bootStatus ?? 200);

      return Promise.resolve({
        ok: status < 400,
        status,
        headers: new Headers({ 'x-server-time': SERVER_TIME }),
        json: () =>
          Promise.resolve(
            login
              ? {
                  accessToken: 'токен',
                  expiresAt: '2026-02-11T11:00:00.000Z',
                  user: {
                    id: 'ba0ba102-a143-4f6c-8538-47bded9939fb',
                    email: 'engineer@fieldstream.local',
                    displayName: 'Инженер',
                    role: 'engineer',
                    permissions: ['overview', 'devices', 'alarms'],
                  },
                }
              : boot(replies.ready ?? true),
          ),
      } as unknown as Response);
    }),
  });
};

let client: QueryClient;

const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={['/login']}>{children}</MemoryRouter>
  </QueryClientProvider>
);

const show = (): void => {
  render(<LoginPage />, { wrapper });
};

const signIn = async (): Promise<void> => {
  await userEvent.type(screen.getByLabelText(/Пароль/), 'пароль стенда');
  await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
};

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useSessionStore.setState({ accessToken: null, expiresAt: null, user: null, checked: true });
});

afterEach(() => {
  cleanup();
  client.clear();
});

describe('экран входа', () => {
  it('удачный вход кладёт сессию в память вкладки', async () => {
    stubFetch();
    show();

    await signIn();

    await waitFor(() => {
      expect(useSessionStore.getState().accessToken).toBe('токен');
    });
    expect(useSessionStore.getState().user?.email).toBe('engineer@fieldstream.local');
  });

  /** Неверный пароль и упавший сервер это разные беды, и человеку надо сказать какая. */
  it('неверный пароль объясняется словами, а не кодом ответа', async () => {
    stubFetch({ loginStatus: 401 });
    show();

    await signIn();

    expect(await screen.findByRole('alert')).toHaveTextContent('Неверная почта или пароль');
    expect(useSessionStore.getState().accessToken).toBeNull();
  });

  it('недоступный сервер не выглядит как неверный пароль', async () => {
    stubFetch({ loginStatus: 503 });
    show();

    await signIn();

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер недоступен');
  });

  it('слишком частые попытки объясняются отдельно', async () => {
    stubFetch({ loginStatus: 429 });
    show();

    await signIn();

    expect(await screen.findByRole('alert')).toHaveTextContent('Слишком много попыток');
  });

  /** Повторное нажатие во время запроса отправило бы вторую попытку и съело бы её у ограничителя. */
  it('во время запроса кнопка занята и говорит об этом', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });
    const reply = (body: unknown): Response =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'x-server-time': SERVER_TIME }),
        json: () => Promise.resolve(body),
      }) as unknown as Response;

    Object.defineProperty(globalThis, 'fetch', {
      writable: true,
      value: vi.fn((_path: string, init?: RequestInit) =>
        init?.method === 'POST' ? held.then(() => reply({})) : Promise.resolve(reply(boot(true))),
      ),
    });
    show();

    await signIn();

    expect(await screen.findByRole('button', { name: 'Входим' })).toBeDisabled();
    release();
  });

  it('пока стенд готовится, видны стадии, а не пустое место', async () => {
    stubFetch({ ready: false });
    show();

    expect(await screen.findByText('Стенд готовится')).toBeInTheDocument();
    expect(screen.getByText('графики за неделю появятся после засева')).toBeInTheDocument();
  });

  it('недоступный шлюз панель готовности объясняет, а не молчит', async () => {
    stubFetch({ bootStatus: 503 });
    show();

    expect(await screen.findByText('Стенд не отвечает')).toBeInTheDocument();
  });
});
