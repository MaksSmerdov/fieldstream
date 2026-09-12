import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AlarmRuleAuditResponse,
  AlarmRuleView,
  AlarmRulesResponse,
  ModuleId,
} from '@fieldstream/contracts';
import { RulesPanel } from '../src/features/rules/components/RulesPanel/RulesPanel.js';
import { useSessionStore } from '../src/shared/auth/session-store.js';

const SERVER_TIME = '2026-02-11T10:00:00.000Z';
const LABELS = { supply_temp_c: 'Температура подачи' };

const rule = (mode: AlarmRuleView['mode'], maxValue: number): AlarmRuleView => ({
  metricKey: 'supply_temp_c',
  mode,
  minValue: -28,
  maxValue,
  hysteresis: 1,
  debounceCycles: 3,
  severity: 'warning',
  enabled: true,
  updatedBy: null,
  updatedAt: '2026-02-10T10:00:00.000Z',
});

const audit = (): AlarmRuleAuditResponse => ({
  deviceCode: 'RC-101',
  serverTime: SERVER_TIME,
  items: [
    {
      id: '1',
      metricKey: 'supply_temp_c',
      mode: 'cooling',
      changedBy: 'engineer@fieldstream.local',
      changedAt: '2026-02-11T09:00:00.000Z',
      created: false,
      fields: [{ field: 'maxValue', before: 2, after: 4 }],
    },
  ],
});

interface Replies {
  readonly rules?: readonly AlarmRuleView[];
  readonly status?: number;
}

let sent: { path: string; body: unknown } | null = null;

/** Ответы шлюза по адресам: правка проходит через настоящий слой запросов и разбор схем. */
const stubFetch = (replies: Replies = {}): void => {
  const rules: AlarmRulesResponse = {
    deviceCode: 'RC-101',
    rules: replies.rules ?? [rule('cooling', 2), rule('defrost', 12)],
  };

  Object.defineProperty(globalThis, 'fetch', {
    writable: true,
    value: vi.fn((path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const raw = typeof init.body === 'string' ? init.body : '{}';
        sent = { path, body: JSON.parse(raw) };
      }

      const body: unknown = path.includes('/audit')
        ? audit()
        : init?.method === 'PUT'
          ? {
              deviceCode: 'RC-101',
              changes: [
                {
                  metricKey: 'supply_temp_c',
                  mode: 'cooling',
                  created: false,
                  changed: ['hysteresis'],
                },
              ],
              rules: rules.rules,
            }
          : rules;

      return Promise.resolve({
        ok: (replies.status ?? 200) < 400,
        status: replies.status ?? 200,
        headers: new Headers({ 'x-server-time': SERVER_TIME }),
        json: () => Promise.resolve(body),
      } as unknown as Response);
    }),
  });
};

let client: QueryClient;

const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

const signIn = (permissions: readonly ModuleId[]): void => {
  useSessionStore.setState({
    accessToken: 'токен',
    expiresAt: '2026-02-11T11:00:00.000Z',
    user: {
      id: 'ba0ba102-a143-4f6c-8538-47bded9939fb',
      email: 'engineer@fieldstream.local',
      displayName: 'Инженер',
      role: permissions.includes('alarm-rules.edit') ? 'engineer' : 'viewer',
      permissions: [...permissions],
    },
    checked: true,
  });
};

const show = (): void => {
  render(<RulesPanel code="RC-101" labels={LABELS} />, { wrapper });
};

beforeEach(() => {
  sent = null;
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  signIn(['overview', 'devices', 'alarms', 'alarm-rules.edit']);
});

afterEach(() => {
  cleanup();
  client.clear();
});

describe('уставки прибора', () => {
  it('пока уставки едут, показывается заглушка', () => {
    stubFetch();
    show();

    expect(screen.getByRole('status', { name: 'Загружаем уставки' })).toBeInTheDocument();
  });

  it('недоступный шлюз объясняется словами', async () => {
    stubFetch({ status: 503 });
    show();

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер недоступен');
  });

  it('прибор без уставок объясняет пустоту, а не показывает пустую таблицу', async () => {
    stubFetch({ rules: [] });
    show();

    expect(await screen.findByText('Уставок у прибора нет')).toBeInTheDocument();
  });

  /** Одна и та же метрика в разных режимах это разные строки: границы в оттайке шире. */
  it('строки идут по режимам, а журнал показывает прежнее и новое значение', async () => {
    stubFetch();
    show();

    expect(await screen.findByLabelText('верхняя граница supply_temp_c cooling')).toHaveValue(2);
    expect(screen.getByLabelText('верхняя граница supply_temp_c defrost')).toHaveValue(12);
    expect(screen.getByText(/верхняя граница: 2 → 4/)).toBeInTheDocument();
  });

  it('правка уезжает одним запросом и только тронутой строкой', async () => {
    stubFetch();
    show();

    const field = await screen.findByLabelText('гистерезис supply_temp_c cooling');
    await userEvent.clear(field);
    await userEvent.type(field, '2');
    await userEvent.click(screen.getByRole('button', { name: /Сохранить/ }));

    await waitFor(() => {
      expect(sent).not.toBeNull();
    });
    expect(sent?.path).toBe('/api/devices/RC-101/alarm-rules');
    expect(sent?.body).toEqual({
      rules: [
        {
          metricKey: 'supply_temp_c',
          mode: 'cooling',
          minValue: -28,
          maxValue: 2,
          hysteresis: 2,
          debounceCycles: 3,
          severity: 'warning',
          enabled: true,
        },
      ],
    });
    expect(await screen.findByText(/Сохранено 1 уставка/)).toBeInTheDocument();
  });

  /** Перевёрнутые границы шлюз отвергнет: экран не должен предлагать отправить их. */
  it('невозможные границы объясняются на месте, а сохранить нельзя', async () => {
    stubFetch();
    show();

    const field = await screen.findByLabelText('нижняя граница supply_temp_c cooling');
    await userEvent.clear(field);
    await userEvent.type(field, '100');

    expect(await screen.findByText(/должна быть меньше верхней/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Сохранить/ })).toBeDisabled();
  });

  it('без права на правку поля закрыты, а кнопки сохранения нет вовсе', async () => {
    signIn(['overview', 'devices', 'alarms']);
    stubFetch();
    show();

    expect(await screen.findByLabelText('гистерезис supply_temp_c cooling')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Сохранить/ })).not.toBeInTheDocument();
    expect(screen.getByText('правка уставок закрыта для вашей роли')).toBeInTheDocument();
  });
});
