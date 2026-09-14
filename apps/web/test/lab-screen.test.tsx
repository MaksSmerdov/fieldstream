import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  labFaultRequestSchema,
  labFaultsResponseSchema,
  labLinesResponseSchema,
  simClearFaultsQuerySchema,
  simFaultSchema,
  topologyResponseSchema,
} from '@fieldstream/contracts';
import type {
  LineStatus,
  ModuleId,
  SimFault,
  SimFaultKind,
  TopologyDevice,
  TopologyResponse,
} from '@fieldstream/contracts';
import { LabPage } from '../src/pages/LabPage.js';
import { queryKeys } from '../src/shared/api/query-keys.js';
import { useSessionStore } from '../src/shared/auth/session-store.js';
import { resetServerClock } from '../src/shared/time/serverClock.js';

const SERVER_TIME = '2026-02-11T10:00:00.000Z';

const at = (offsetMs: number): string => new Date(Date.parse(SERVER_TIME) + offsetMs).toISOString();

type Breaker = LineStatus['devices'][number]['breaker'];

const CLOSED: Breaker = { state: 'closed', failures: 0, probeDelayMs: 0, nextProbeAt: null };

const topologyDevice = (
  code: string,
  label: string,
  profileKey: string,
  slaveId: number,
): TopologyDevice => ({
  code,
  label,
  profileKey,
  profileVersion: 1,
  slaveId,
  enabled: true,
  status: 'online',
  reason: 'ok',
  mode: 'cooling',
  since: at(-3_600_000),
  lastOkAt: at(-5_000),
  activeAlarms: 0,
  worstSeverity: null,
  stale: false,
  staleSince: at(-5_000),
});

const TOPOLOGY: TopologyResponse = topologyResponseSchema.parse({
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
              devices: [
                topologyDevice('RC-101', 'Камера 1', 'rc-2000', 1),
                topologyDevice('RC-102', 'Камера 2', 'rc-2000', 2),
              ],
            },
            {
              code: 'L2',
              baud: 9600,
              pollIntervalMs: 10_000,
              requestTimeoutMs: 600,
              planMode: 'merged',
              enabled: true,
              devices: [topologyDevice('PM-201', 'Счётчик ввода', 'pm-3phase', 1)],
            },
          ],
        },
      ],
    },
  ],
});

const lineStatus = (
  lineCode: string,
  devices: readonly (readonly [string, Breaker])[],
  patch: Partial<LineStatus> = {},
): LineStatus => ({
  schema: 'line.status',
  v: 1,
  ts: at(-1_000),
  lineCode,
  running: true,
  connected: true,
  planMode: 'merged',
  pollIntervalMs: 10_000,
  requestTimeoutMs: 600,
  hardTimeoutMs: 2_000,
  watchdog: { limitMs: 12_000, cycleStartedAt: null, trips: 0 },
  lastCycle: { at: at(-2_000), outcome: 'polled', durationMs: 1_400, polled: 2, failed: 0 },
  reconnects: [],
  devices: devices.map(([deviceCode, breaker], index) => ({
    deviceCode,
    slaveId: index + 1,
    breaker,
  })),
  latency: {
    bucketsMs: [25, 50, 100],
    counts: [40, 60, 20, 0],
    samples: 120,
    timeouts: 2,
    p50Ms: 30,
    p95Ms: 70,
    p99Ms: 90,
    suggestedTimeoutMs: 500,
  },
  ...patch,
});

const LINES: readonly LineStatus[] = [
  lineStatus('L1', [
    ['RC-101', CLOSED],
    ['RC-102', { state: 'open', failures: 3, probeDelayMs: 60_000, nextProbeAt: at(30_000) }],
  ]),
  lineStatus(
    'L2',
    [['PM-201', { state: 'open', failures: 5, probeDelayMs: 120_000, nextProbeAt: at(-5_000) }]],
    { ts: at(-60_000), connected: false },
  ),
];

const LINE_FAULT: SimFault = simFaultSchema.parse({
  id: 'fault-line',
  targetKind: 'line',
  targetId: 'L1',
  kind: 'offline',
  since: at(-10_000),
  expiresAt: at(200_000),
  exceptionCode: null,
  paramKey: null,
});

const DEVICE_FAULT: SimFault = simFaultSchema.parse({
  id: 'fault-device',
  targetKind: 'device',
  targetId: 'RC-101',
  kind: 'silent',
  since: at(-10_000),
  expiresAt: at(200_000),
  exceptionCode: null,
  paramKey: null,
});

interface Stand {
  lines: readonly LineStatus[];
  faults: SimFault[];
  linesStatus: number;
  faultsStatus: number;
  topologyStatus: number;
  rejectKinds: Partial<Record<SimFaultKind, number>>;
  hold: Promise<void>;
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

let stand: Stand;
let calls: Call[] = [];

const reply = (status: number, body: unknown): Promise<Response> =>
  Promise.resolve({
    ok: status < 400,
    status,
    headers: new Headers({ 'x-server-time': SERVER_TIME }),
    json: () => Promise.resolve(body),
  } as unknown as Response);

/** Ответы шлюза по адресам: поломки живут в памяти, как на настоящем стенде. */
const route = (path: string, init?: RequestInit): Promise<Response> => {
  const method = init?.method ?? 'GET';
  const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  calls.push({ method, path, body });
  const url = new URL(path, 'http://stand');

  if (url.pathname === '/api/topology') {
    return stand.topologyStatus === 200
      ? reply(200, TOPOLOGY)
      : reply(stand.topologyStatus, { message: 'топология не собрана' });
  }

  if (url.pathname === '/api/lab/lines') {
    return stand.linesStatus === 200
      ? reply(200, labLinesResponseSchema.parse({ serverTime: SERVER_TIME, lines: stand.lines }))
      : reply(stand.linesStatus, { message: 'шлюз недоступен' });
  }

  if (url.pathname !== '/api/lab/faults') return reply(404, { message: 'нет такого адреса' });

  if (method === 'POST') {
    const request = labFaultRequestSchema.parse(body);
    const rejected = stand.rejectKinds[request.kind];
    if (rejected !== undefined) {
      return stand.hold.then(() => reply(rejected, { message: 'симулятор отклонил поломку' }));
    }
    const fault = simFaultSchema.parse({
      id: `fault-${stand.faults.length + 1}`,
      targetKind: request.targetKind,
      targetId: request.targetId,
      kind: request.kind,
      since: SERVER_TIME,
      expiresAt: at(request.ttlSec * 1_000),
      exceptionCode: null,
      paramKey: null,
    });
    stand.faults = [...stand.faults, fault];
    return reply(201, fault);
  }

  if (method === 'DELETE') {
    const filter = simClearFaultsQuerySchema.parse(Object.fromEntries(url.searchParams));
    const before = stand.faults.length;
    stand.faults = stand.faults.filter(
      (fault) =>
        !(
          (filter.targetId === undefined || fault.targetId === filter.targetId) &&
          (filter.kind === undefined || fault.kind === filter.kind)
        ),
    );
    return reply(200, { removed: before - stand.faults.length });
  }

  return stand.faultsStatus === 200
    ? reply(200, labFaultsResponseSchema.parse({ serverTime: SERVER_TIME, faults: stand.faults }))
    : reply(stand.faultsStatus, { message: 'симулятор стенда недоступен' });
};

let client: QueryClient;

const signIn = (permissions: readonly ModuleId[]): void => {
  useSessionStore.setState({
    accessToken: 'токен',
    expiresAt: '2026-02-11T11:00:00.000Z',
    user: {
      id: 'ba0ba102-a143-4f6c-8538-47bded9939fb',
      email: 'engineer@fieldstream.local',
      displayName: 'Инженер',
      role: permissions.includes('lab.inject') ? 'engineer' : 'viewer',
      permissions: [...permissions],
    },
    checked: true,
  });
};

const show = (entry = '/lab'): void => {
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  render(<LabPage />, { wrapper });
};

beforeEach(() => {
  calls = [];
  stand = {
    lines: LINES,
    faults: [LINE_FAULT],
    linesStatus: 200,
    faultsStatus: 200,
    topologyStatus: 200,
    rejectKinds: {},
    hold: Promise.resolve(),
  };
  Object.defineProperty(globalThis, 'fetch', { writable: true, value: vi.fn(route) });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  signIn(['overview', 'devices', 'alarms', 'lab', 'lab.inject']);
});

afterEach(() => {
  cleanup();
  client.clear();
  resetServerClock();
});

describe('лаборатория отказов', () => {
  it('пока снимки линий едут, показывается заглушка', () => {
    show();

    expect(screen.getByRole('status', { name: 'Загружаем снимки линий' })).toBeInTheDocument();
  });

  it('недоступные снимки линий объясняются словами, повтор возвращает экран', async () => {
    stand.linesStatus = 503;
    show();

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер недоступен');

    stand.linesStatus = 200;
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(
      await screen.findByRole('heading', { name: 'Прибор RC-101 на линии L1' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('без снимков линий пустое состояние объясняет, чего ждать', async () => {
    stand.lines = [];
    show();

    expect(await screen.findByText('Сборщик ещё не прислал снимки линий')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Проверить снова' })).toBeInTheDocument();
  });

  it('переключатель вносит поломку и снимает её фильтром по цели и виду', async () => {
    show();

    const group = within(await screen.findByRole('group', { name: 'Поломки прибора RC-101' }));
    await waitFor(() => {
      expect(group.getByRole('switch', { name: 'молчит' })).toBeEnabled();
    });
    expect(group.getByRole('switch', { name: 'дверь не закрывается' })).toBeInTheDocument();

    await userEvent.click(group.getByRole('switch', { name: 'молчит' }));

    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/api/lab/faults',
        body: { targetKind: 'device', targetId: 'RC-101', kind: 'silent', ttlSec: 300 },
      });
    });
    await waitFor(() => {
      expect(group.getByRole('switch', { name: 'молчит' })).toBeChecked();
    });
    expect(group.getByText(/^ещё [45]:\d\d$/)).toBeInTheDocument();

    await waitFor(() => {
      expect(group.getByRole('switch', { name: 'молчит' })).toBeEnabled();
    });
    await userEvent.click(group.getByRole('switch', { name: 'молчит' }));

    await waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.method === 'DELETE' && call.path === '/api/lab/faults?targetId=RC-101&kind=silent',
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(group.getByRole('switch', { name: 'молчит' })).not.toBeChecked();
    });
  });

  it('без права вносить поломки переключатели недоступны и это объяснено', async () => {
    signIn(['overview', 'devices', 'alarms', 'lab']);
    show();

    expect(await screen.findByText(/Вносить и снимать поломки может инженер/)).toBeInTheDocument();
    expect(await screen.findByText('Действует 1 поломка')).toBeInTheDocument();

    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBeGreaterThan(0);
    for (const control of switches) expect(control).toBeDisabled();

    const line = within(screen.getByRole('group', { name: 'Поломки линии L1' }));
    expect(line.getByRole('switch', { name: 'обрыв порта шлюза' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Снять все' })).toBeDisabled();
  });

  it('недоступный симулятор даёт уведомление, а приборы защиты продолжают работать', async () => {
    stand.faultsStatus = 503;
    show();

    expect(await screen.findByText(/Шлюз не видит симулятор стенда/)).toBeInTheDocument();
    expect(screen.getByText('Поломки неизвестны')).toBeInTheDocument();

    for (const control of screen.getAllByRole('switch')) expect(control).toBeDisabled();
    expect(screen.getByRole('heading', { name: 'Прибор RC-101 на линии L1' })).toBeInTheDocument();
    expect(screen.getByText('замкнут')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /^Гистограмма времени ответа линии L1/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('симулятор пропал после загрузки поломок: прежние состояния скрыты, переключатели недоступны', async () => {
    show();

    expect(await screen.findByText('Действует 1 поломка')).toBeInTheDocument();
    const line = within(screen.getByRole('group', { name: 'Поломки линии L1' }));
    await waitFor(() => {
      expect(line.getByRole('switch', { name: 'обрыв порта шлюза' })).toBeEnabled();
    });
    expect(line.getByRole('switch', { name: 'обрыв порта шлюза' })).toBeChecked();

    stand.faultsStatus = 503;
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.labFaults });
    });

    expect(await screen.findByText(/Шлюз не видит симулятор стенда/)).toBeInTheDocument();
    expect(screen.getByText('Поломки неизвестны')).toBeInTheDocument();
    expect(line.getByRole('switch', { name: 'обрыв порта шлюза' })).not.toBeChecked();
    for (const control of screen.getAllByRole('switch')) expect(control).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Снять все' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('отказ внесения виден рядом, даже если следом прошло другое действие', async () => {
    let release = (): void => undefined;
    stand.hold = new Promise((resolve) => {
      release = resolve;
    });
    stand.rejectKinds = { silent: 409 };
    show();

    const group = within(await screen.findByRole('group', { name: 'Поломки прибора RC-101' }));
    await waitFor(() => {
      expect(group.getByRole('switch', { name: 'молчит' })).toBeEnabled();
    });

    await userEvent.click(group.getByRole('switch', { name: 'молчит' }));
    await waitFor(() => {
      expect(group.getByRole('switch', { name: 'молчит' })).toBeDisabled();
    });
    await userEvent.click(group.getByRole('switch', { name: 'мусор в кадре' }));
    await waitFor(() => {
      expect(group.getByRole('switch', { name: 'мусор в кадре' })).toBeChecked();
    });

    release();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось внести поломку «молчит» на RC-101: симулятор отклонил поломку',
    );
    expect(group.getByRole('switch', { name: 'молчит' })).not.toBeChecked();
    expect(group.getByRole('switch', { name: 'мусор в кадре' })).toBeChecked();
    expect(screen.getByRole('heading', { name: 'Прибор RC-101 на линии L1' })).toBeInTheDocument();
    expect(screen.getByText('замкнут')).toBeInTheDocument();
  });

  it('«Снять все» снимает поломки без фильтра и выключает переключатели', async () => {
    stand.faults = [LINE_FAULT, DEVICE_FAULT];
    show();

    expect(await screen.findByText('Действует 2 поломки')).toBeInTheDocument();
    const clearAll = screen.getByRole('button', { name: 'Снять все' });
    await waitFor(() => {
      expect(clearAll).toBeEnabled();
    });
    expect(
      within(screen.getByRole('group', { name: 'Поломки прибора RC-101' })).getByRole('switch', {
        name: 'молчит',
      }),
    ).toBeChecked();

    await userEvent.click(clearAll);

    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([
        '/api/lab/faults',
      ]);
    });
    expect(await screen.findByText('Действующих поломок нет')).toBeInTheDocument();
    for (const control of screen.getAllByRole('switch')) expect(control).not.toBeChecked();
  });

  it('без топологии панель предупреждает, а после повтора появляется поломка двери', async () => {
    stand.topologyStatus = 500;
    show();

    expect(await screen.findByText(/Модель прибора неизвестна/)).toBeInTheDocument();
    const group = within(screen.getByRole('group', { name: 'Поломки прибора RC-101' }));
    expect(group.queryByRole('switch', { name: 'дверь не закрывается' })).not.toBeInTheDocument();
    expect(screen.getByText(/Обновить данные не удалось/)).toBeInTheDocument();

    stand.topologyStatus = 200;
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByRole('switch', { name: 'дверь не закрывается' })).toBeInTheDocument();
    expect(screen.queryByText(/Модель прибора неизвестна/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Обновить данные не удалось/)).not.toBeInTheDocument();
  });

  it('выбор прибора в панели меняет приборы защиты', async () => {
    show();

    expect(
      await screen.findByRole('heading', { name: 'Прибор RC-101 на линии L1' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /RC-101/ })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: /RC-102/ }));

    expect(
      await screen.findByRole('heading', { name: 'Прибор RC-102 на линии L1' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Поломки прибора RC-102' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Поломки прибора RC-101' })).not.toBeInTheDocument();
  });

  it('прибор из адреса открывается сразу, у счётчика нет поломки двери', async () => {
    show('/lab?device=PM-201');

    const group = within(await screen.findByRole('group', { name: 'Поломки прибора PM-201' }));

    expect(screen.getByRole('heading', { name: 'Прибор PM-201 на линии L2' })).toBeInTheDocument();
    expect(group.queryByRole('switch', { name: 'дверь не закрывается' })).not.toBeInTheDocument();
  });

  it('состояние размыкателя показано словами с отсчётом до пробы', async () => {
    show('/lab?device=RC-102');

    expect(await screen.findByText('разомкнут')).toBeInTheDocument();
    expect(screen.getByText('отказов подряд: 3')).toBeInTheDocument();
    expect(screen.getByText(/^проба через 0:(29|30) из 60 с$/)).toBeInTheDocument();
  });

  it('наступившая проба на устаревшем снимке показана как ожидание', async () => {
    show('/lab?device=PM-201');

    expect(await screen.findByText('ждёт пробы')).toBeInTheDocument();
    expect(screen.getByText(/Данные линии L2 устарели/)).toBeInTheDocument();
    expect(screen.getByText('порт недоступен')).toBeInTheDocument();
    expect(
      screen.getByText('Порт сейчас недоступен, попыток переподключения ещё не было.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Порт линии не пропадал/)).not.toBeInTheDocument();
  });
});
