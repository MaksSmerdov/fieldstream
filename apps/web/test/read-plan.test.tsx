import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadPlanResponse } from '@fieldstream/contracts';
import { ReadPlanCard } from '../src/features/device/components/ReadPlanCard/ReadPlanCard.js';
import { useSessionStore } from '../src/shared/auth/session-store.js';

const SERVER_TIME = '2026-02-11T10:00:00.000Z';
const LABELS = { supply_temp_c: 'Температура подачи', setpoint_c: 'Уставка температуры' };

const plan = (mode: 'merged' | 'naive'): ReadPlanResponse => ({
  deviceCode: 'RC-101',
  profileKey: 'rc-2000',
  profileVersion: 1,
  mode,
  requests: mode === 'merged' ? 4 : 9,
  registers: 12,
  blocks:
    mode === 'merged'
      ? [
          {
            id: 'merged:input:0',
            registerType: 'input',
            startAddress: 0,
            registerCount: 4,
            paramKeys: ['supply_temp_c'],
            source: 'merged',
          },
          {
            id: 'merged:holding:0',
            registerType: 'holding',
            startAddress: 0,
            registerCount: 1,
            paramKeys: ['setpoint_c'],
            source: 'merged',
          },
        ]
      : [
          {
            id: 'naive:input:0',
            registerType: 'input',
            startAddress: 0,
            registerCount: 1,
            paramKeys: ['supply_temp_c'],
            source: 'naive',
          },
        ],
});

const stubFetch = (status = 200): void => {
  Object.defineProperty(globalThis, 'fetch', {
    writable: true,
    value: vi.fn((path: string) =>
      Promise.resolve({
        ok: status < 400,
        status,
        headers: new Headers({ 'x-server-time': SERVER_TIME }),
        json: () => Promise.resolve(plan(path.includes('naive') ? 'naive' : 'merged')),
      } as unknown as Response),
    ),
  });
};

let client: QueryClient;

const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

const show = (): void => {
  render(<ReadPlanCard code="RC-101" labels={LABELS} />, { wrapper });
};

beforeEach(() => {
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
  cleanup();
  client.clear();
});

describe('карта регистров', () => {
  it('пока планы считаются, показывается заглушка', () => {
    stubFetch();
    show();

    expect(screen.getByRole('status', { name: 'Считаем план чтения' })).toBeInTheDocument();
  });

  it('недоступный шлюз объясняется словами и даёт повтор', async () => {
    stubFetch(503);
    show();

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер недоступен');
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  /** «Четыре запроса» без второго числа ни о чём не говорят: выигрыш это разница планов. */
  it('выигрыш склейки показан числом и склонён по-русски', async () => {
    stubFetch();
    show();

    expect(await screen.findByText('запросов: 4')).toBeInTheDocument();
    expect(screen.getByText('склейка экономит 5 запросов из 9')).toBeInTheDocument();
  });

  it('блоки показаны с адресами и человеческими подписями параметров', async () => {
    stubFetch();
    show();

    expect(await screen.findByText('merged:input:0')).toBeInTheDocument();
    expect(screen.getByText('Температура подачи')).toBeInTheDocument();
    expect(screen.getByText('0…3')).toBeInTheDocument();
    expect(screen.getAllByText('склеен автоматически').length).toBe(2);
  });

  it('переключатель показывает поштучный план, не теряя сравнения', async () => {
    stubFetch();
    show();
    await screen.findByText('merged:input:0');

    await userEvent.click(screen.getByRole('button', { name: 'по одному' }));

    expect(await screen.findByText('naive:input:0')).toBeInTheDocument();
    expect(screen.getByText('запросов: 9')).toBeInTheDocument();
    expect(screen.getByText('по одному параметру')).toBeInTheDocument();
  });
});
