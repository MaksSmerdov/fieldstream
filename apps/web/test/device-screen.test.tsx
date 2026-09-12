import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DeviceEventsResponse,
  DeviceProfileView,
  DeviceSnapshot,
  SeriesResponse,
} from '@fieldstream/contracts';
import { useSessionStore } from '../src/shared/auth/session-store.js';

const chartProps = vi.fn();

vi.mock('../src/shared/charts/TimeChart/TimeChart.js', () => ({
  TimeChart: (props: Record<string, unknown>) => {
    chartProps(props);

    return <div data-testid="chart" />;
  },
}));

const { DevicePage } = await import('../src/pages/DevicePage.js');

const SERVER_TIME = '2026-02-11T10:00:00.000Z';

const profile = (): DeviceProfileView => ({
  deviceCode: 'RC-101',
  profileKey: 'rc-2000',
  profileVersion: 1,
  label: 'Холодильный контроллер RC-2000',
  sections: [
    {
      key: 'temps',
      label: 'Температуры',
      params: [
        {
          metricKey: 'supply_temp_c',
          label: 'Температура подачи',
          unit: '°C',
          precision: 1,
          kind: 'number',
          states: null,
          bits: null,
          range: { min: -30, max: 15 },
        },
      ],
    },
    {
      key: 'states',
      label: 'Состояния',
      params: [
        {
          metricKey: 'compressor_state',
          label: 'Состояние компрессора',
          unit: null,
          precision: 0,
          kind: 'enum',
          states: { '0': 'stopped', '2': 'running' },
          bits: null,
          range: null,
        },
      ],
    },
    {
      key: 'alarms',
      label: 'Аварии',
      params: [
        {
          metricKey: 'alarm_bits',
          label: 'Слово аварий',
          unit: null,
          precision: 0,
          kind: 'bits',
          states: null,
          bits: [
            { bit: 0, key: 'high_temp', label: 'Высокая температура' },
            { bit: 1, key: 'low_temp', label: 'Низкая температура' },
          ],
          range: null,
        },
      ],
    },
  ],
});

const snapshot = (stale = false): DeviceSnapshot => ({
  deviceCode: 'RC-101',
  label: 'Камера 1',
  lineCode: 'L1',
  siteCode: 'SITE-A',
  profileKey: 'rc-2000',
  profileVersion: 1,
  status: 'online',
  reason: 'ok',
  mode: 'cooling',
  since: '2026-02-11T09:00:00.000Z',
  lastOkAt: '2026-02-11T09:59:50.000Z',
  consecutiveErrors: 0,
  stale,
  ts: '2026-02-11T09:59:50.000Z',
  activeAlarms: 0,
  serverTime: SERVER_TIME,
  metrics: [
    {
      metricKey: 'supply_temp_c',
      label: 'Температура подачи',
      unit: '°C',
      kind: 'number',
      precision: 1,
      value: -18.4,
      quality: 'ok',
      ts: '2026-02-11T09:59:50.000Z',
    },
    {
      metricKey: 'compressor_state',
      label: 'Состояние компрессора',
      unit: null,
      kind: 'enum',
      precision: 0,
      value: 2,
      quality: 'ok',
      ts: '2026-02-11T09:59:50.000Z',
    },
    {
      metricKey: 'alarm_bits',
      label: 'Слово аварий',
      unit: null,
      kind: 'bits',
      precision: 0,
      value: 2,
      quality: 'ok',
      ts: '2026-02-11T09:59:50.000Z',
    },
  ],
});

const series = (points: number): SeriesResponse => ({
  deviceCode: 'RC-101',
  metrics: [
    {
      metricKey: 'supply_temp_c',
      points: Array.from({ length: points }, (_item, index) => ({
        t: new Date(Date.parse('2026-02-11T04:00:00.000Z') + index * 30_000).toISOString(),
        avg: -18 + index / 10,
        min: -19,
        max: -17,
        n: 3,
      })),
    },
  ],
  meta: {
    source: 'readings',
    bucketMs: 30_000,
    points,
    truncated: true,
    from: '2026-02-11T04:00:00.000Z',
    to: SERVER_TIME,
  },
});

const events = (): DeviceEventsResponse => ({
  deviceCode: 'RC-101',
  from: '2026-02-11T04:00:00.000Z',
  to: SERVER_TIME,
  spans: [
    { mode: 'cooling', from: '2026-02-11T04:00:00.000Z', to: '2026-02-11T06:00:00.000Z' },
    { mode: 'defrost', from: '2026-02-11T06:00:00.000Z', to: '2026-02-11T06:20:00.000Z' },
    { mode: 'cooling', from: '2026-02-11T06:20:00.000Z', to: SERVER_TIME },
  ],
  events: [],
  serverTime: SERVER_TIME,
});

interface Replies {
  readonly snapshot?: DeviceSnapshot;
  readonly series?: SeriesResponse;
  readonly status?: number;
}

/** Ответы шлюза по адресам: тест проходит через настоящий слой запросов и разбор схем. */
const stubFetch = (replies: Replies = {}): void => {
  const body = (path: string): unknown => {
    if (path.includes('/profile')) return profile();
    if (path.includes('/latest')) return replies.snapshot ?? snapshot();
    if (path.includes('/series')) return replies.series ?? series(240);
    if (path.includes('/events')) return events();

    return {};
  };

  Object.defineProperty(globalThis, 'fetch', {
    writable: true,
    value: vi.fn((path: string) =>
      Promise.resolve({
        ok: (replies.status ?? 200) < 400,
        status: replies.status ?? 200,
        headers: new Headers({ 'x-server-time': SERVER_TIME }),
        json: () => Promise.resolve(body(path)),
      } as unknown as Response),
    ),
  });
};

let client: QueryClient;

const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={['/device/RC-101']}>
      <Routes>
        <Route path="/device/:code" element={children} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>
);

const show = (): void => {
  render(<DevicePage />, { wrapper });
};

beforeEach(() => {
  chartProps.mockClear();
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
  // Автоочистка RTL держится на глобальном afterEach, а тесты идут без глобалей
  cleanup();
  client.clear();
});

describe('экран прибора', () => {
  it('пока данные едут, показывается заглушка нужной высоты', () => {
    stubFetch();
    show();

    expect(screen.getByRole('status', { name: 'Загружаем прибор' })).toBeInTheDocument();
  });

  it('недоступный шлюз объясняется словами и даёт повтор', async () => {
    stubFetch({ status: 503 });
    show();

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер недоступен');
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  /** Код состояния это машинное имя из профиля, человеку нужно слово. */
  it('значения разложены по секциям, перечисление показано словом, поднят только нужный бит', async () => {
    stubFetch();
    show();

    expect(await screen.findByText('Температуры')).toBeInTheDocument();
    expect(screen.getByText('-18.4 °C')).toBeInTheDocument();
    expect(screen.getByText('работает')).toBeInTheDocument();
    expect(screen.getByText('Низкая температура')).toBeInTheDocument();
    expect(screen.queryByText('Высокая температура')).not.toBeInTheDocument();
  });

  it('оттайка уезжает на график полосой, а источник данных подписан', async () => {
    stubFetch();
    show();

    await screen.findByTestId('chart');

    await waitFor(() => {
      expect(chartProps).toHaveBeenCalled();
    });
    const props = chartProps.mock.calls.at(-1)?.[0] as { bands: unknown[] };
    expect(props.bands).toHaveLength(1);
    expect(screen.getByText(/источник: сырые отсчёты/)).toHaveTextContent('шаг 30 с');
    expect(screen.getByText(/источник: сырые отсчёты/)).toHaveTextContent('окно прорежено');
  });

  it('пустое окно объясняется словами, а не рисуется пустым графиком', async () => {
    stubFetch({ series: series(0) });
    show();

    expect(await screen.findByText('За это окно данных нет')).toBeInTheDocument();
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
  });

  /** Старое число выглядит как правда: протухшее значение показывается прочерком. */
  it('протухшие значения показываются прочерком, а не последним известным числом', async () => {
    stubFetch({ snapshot: snapshot(true) });
    show();

    await screen.findByText('Температуры');
    expect(screen.queryByText('-18.4 °C')).not.toBeInTheDocument();
    expect(screen.getAllByText('–').length).toBeGreaterThan(0);
  });
});
