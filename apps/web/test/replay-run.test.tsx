import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alarmRulesResponseSchema,
  deviceProfileViewSchema,
  replayDiffSchema,
  replayEpisodesResponseSchema,
  replayRunSchema,
  replayRunsResponseSchema,
  seriesResponseSchema,
  topologyResponseSchema,
} from '@fieldstream/contracts';
import type {
  ModuleId,
  ReplayDiff,
  ReplayEpisode,
  ReplayRun,
  SeriesResponse,
} from '@fieldstream/contracts';
import type { ChartBand, ChartThreshold } from '../src/shared/charts/TimeChart/TimeChart.js';
import { useSessionStore } from '../src/shared/auth/session-store.js';
import { resetServerClock } from '../src/shared/time/serverClock.js';

const chartProps = vi.fn();

vi.mock('../src/shared/charts/TimeChart/TimeChart.js', () => ({
  TimeChart: (props: Record<string, unknown>) => {
    chartProps(props);

    return <div data-testid="chart" role="img" aria-label={String(props['label'])} />;
  },
}));

const { ReplayPage } = await import('../src/pages/ReplayPage.js');
const { RUN_POLL_MS } = await import('../src/features/replay/hooks/runs/useReplayRun.js');

const SERVER_TIME = '2026-02-11T10:00:00.000Z';
const RUN_ID = '5f0c2a8e-3b1d-4c6f-9a7e-2d4b6c8e0f11';
const ENGINEER = 'engineer@fieldstream.local';
const RETENTION_MS = 604_800_000;

const at = (offsetMs: number): string => new Date(Date.parse(SERVER_TIME) + offsetMs).toISOString();

const TOPOLOGY = topologyResponseSchema.parse({ serverTime: SERVER_TIME, sites: [] });

const PROFILE = deviceProfileViewSchema.parse({
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
          metricKey: 'evap_temp_c',
          label: 'Температура испарителя',
          unit: '°C',
          precision: 1,
          kind: 'number',
          states: null,
          bits: null,
          range: null,
        },
      ],
    },
  ],
});

/** Прогон, прошедший схему контракта. */
const run = (patch: Partial<ReplayRun> = {}): ReplayRun =>
  replayRunSchema.parse({
    id: RUN_ID,
    status: 'queued',
    requestedBy: ENGINEER,
    from: at(-3_600_000),
    to: SERVER_TIME,
    deviceCodes: ['RC-101', 'RC-102'],
    patches: [{ metricKey: 'evap_temp_c', mode: 'defrost', maxValue: 8 }],
    progress: { offsetsTotal: 0, offsetsDone: 0, framesMatched: 0, framesRejected: 0 },
    coveredFrom: null,
    coveredTo: null,
    groupId: null,
    error: null,
    createdAt: at(-60_000),
    startedAt: null,
    finishedAt: null,
    ...patch,
  });

const GROUP = `fs-replay-${RUN_ID}`;

const progress = (offsetsTotal: number, offsetsDone: number) => ({
  offsetsTotal,
  offsetsDone,
  framesMatched: Math.floor(offsetsDone / 4),
  framesRejected: 0,
});

const DONE = run({
  status: 'done',
  progress: { offsetsTotal: 8_000, offsetsDone: 8_000, framesMatched: 720, framesRejected: 2 },
  coveredFrom: at(-3_595_000),
  coveredTo: at(-5_000),
  groupId: GROUP,
  startedAt: at(-59_000),
  finishedAt: at(-17_000),
});

const values = {
  minValue: -28,
  maxValue: 12,
  hysteresis: 1,
  debounceCycles: 6,
  severity: 'info',
  enabled: true,
} as const;

const DIFF: ReplayDiff = replayDiffSchema.parse({
  run: DONE,
  changedRules: ['RC-101', 'RC-102'].map((deviceCode) => ({
    deviceCode,
    metricKey: 'evap_temp_c',
    mode: 'defrost',
    baseline: values,
    patched: { ...values, maxValue: 8 },
  })),
  rows: [
    {
      deviceCode: 'RC-101',
      metricKey: 'evap_temp_c',
      mode: 'defrost',
      baseline: 0,
      patched: 2,
      added: 2,
      removed: 0,
      live: 0,
    },
    {
      deviceCode: 'RC-102',
      metricKey: 'evap_temp_c',
      mode: 'defrost',
      baseline: 0,
      patched: 1,
      added: 1,
      removed: 0,
      live: 0,
    },
  ],
});

const episode = (
  deviceCode: string,
  raisedAt: string,
  clearedAt: string | null,
): ReplayEpisode => ({
  deviceCode,
  metricKey: 'evap_temp_c',
  mode: 'defrost',
  severity: 'info',
  boundary: 'max',
  value: 9.4,
  threshold: 8,
  raisedAt,
  clearedAt,
  clearedValue: clearedAt === null ? null : 6.8,
});

const SERIES: SeriesResponse = seriesResponseSchema.parse({
  deviceCode: 'RC-101',
  metrics: [
    {
      metricKey: 'evap_temp_c',
      points: Array.from({ length: 12 }, (_item, index) => ({
        t: at(-3_600_000 + index * 300_000),
        avg: -20 + index * 2.5,
        min: -21,
        max: 10,
        n: 30,
      })),
    },
  ],
  meta: {
    source: 'readings',
    bucketMs: 300_000,
    points: 12,
    truncated: false,
    from: at(-3_600_000),
    to: SERVER_TIME,
  },
});

type Step = ReplayRun | number;

interface Stand {
  runs: ReplayRun[];
  active: ReplayRun | null;
  listStatus: number;
  listHold: Promise<void>;
  /** Шаги хода: прогон или код ошибки опроса; последний шаг повторяется. */
  progress: Step[];
  diff: ReplayDiff | number;
  series: SeriesResponse;
  /** Эпизоды «было» у каждой строки. */
  baseline: (deviceCode: string) => ReplayEpisode[];
}

interface Call {
  readonly method: string;
  readonly path: string;
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

/** Ответы шлюза по адресам: ход прогона отдаётся по одному шагу на каждый опрос. */
const route = async (path: string, init?: RequestInit): Promise<Response> => {
  const method = init?.method ?? 'GET';
  calls.push({ method, path });
  const url = new URL(path, 'http://stand');

  if (url.pathname === '/api/topology') return reply(200, TOPOLOGY);
  if (url.pathname.endsWith('/profile')) return reply(200, PROFILE);
  if (url.pathname.endsWith('/alarm-rules')) {
    return reply(200, alarmRulesResponseSchema.parse({ deviceCode: 'RC-101', rules: [] }));
  }
  if (url.pathname.endsWith('/series')) return reply(200, stand.series);

  if (url.pathname === '/api/replay-runs') {
    await stand.listHold;
    return stand.listStatus === 200
      ? reply(
          200,
          replayRunsResponseSchema.parse({
            serverTime: SERVER_TIME,
            retentionMs: RETENTION_MS,
            runs: stand.runs,
            activeRun: stand.active,
          }),
        )
      : reply(stand.listStatus, { message: 'шлюз недоступен' });
  }

  if (url.pathname === `/api/replay-runs/${RUN_ID}/diff`) {
    return typeof stand.diff === 'number'
      ? reply(stand.diff, { message: 'разница не прочитана' })
      : reply(200, stand.diff);
  }

  if (url.pathname === `/api/replay-runs/${RUN_ID}/episodes`) {
    const deviceCode = url.searchParams.get('deviceCode') ?? '';
    return reply(
      200,
      replayEpisodesResponseSchema.parse({
        runId: RUN_ID,
        deviceCode,
        metricKey: url.searchParams.get('metricKey'),
        mode: url.searchParams.get('mode'),
        baseline: stand.baseline(deviceCode),
        patched: [
          episode(deviceCode, at(-3_000_000), at(-2_880_000)),
          ...(deviceCode === 'RC-101' ? [episode(deviceCode, at(-600_000), null)] : []),
        ],
        truncated: false,
      }),
    );
  }

  if (url.pathname === `/api/replay-runs/${RUN_ID}`) {
    const next = stand.progress.length > 1 ? stand.progress.shift() : stand.progress[0];
    if (next === undefined) return reply(404, { message: 'прогона нет' });
    if (typeof next === 'number') return reply(next, { message: 'шлюз перегружен' });
    if (next.status === 'done' || next.status === 'failed') {
      stand.active = null;
      stand.runs = [next];
    }
    return reply(200, next);
  }

  return reply(404, { message: 'нет такого адреса' });
};

const readsOf = (path: string): number =>
  calls.filter((call) => call.method === 'GET' && call.path === path).length;

const readsStarting = (path: string): number =>
  calls.filter((call) => call.method === 'GET' && call.path.startsWith(path)).length;

let client: QueryClient;

const signIn = (permissions: readonly ModuleId[]): void => {
  useSessionStore.setState({
    accessToken: 'токен',
    expiresAt: '2026-02-11T11:00:00.000Z',
    user: {
      id: 'ba0ba102-a143-4f6c-8538-47bded9939fb',
      email: ENGINEER,
      displayName: 'Инженер',
      role: 'viewer',
      permissions: [...permissions],
    },
    checked: true,
  });
};

const show = (entry = '/replay'): void => {
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  render(<ReplayPage />, { wrapper });
};

const panel = async () => within(await screen.findByRole('region', { name: 'Ход перепрогона' }));

const result = async () =>
  within(await screen.findByRole('region', { name: 'Разница срабатываний' }));

/** Поддельные часы идут вместе с настоящими, но опрос можно промотать. */
const fakeClock = (): void => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
};

/** Проматывает поддельные часы так, чтобы React успел отрисовать пришедшие ответы. */
const pass = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const lastChart = (): { bands: ChartBand[]; thresholds: ChartThreshold[]; label: string } =>
  chartProps.mock.calls.at(-1)?.[0] as {
    bands: ChartBand[];
    thresholds: ChartThreshold[];
    label: string;
  };

beforeEach(() => {
  calls = [];
  chartProps.mockClear();
  stand = {
    runs: [],
    active: null,
    listStatus: 200,
    listHold: Promise.resolve(),
    progress: [],
    diff: DIFF,
    series: SERIES,
    baseline: () => [],
  };
  Object.defineProperty(globalThis, 'fetch', { writable: true, value: vi.fn(route) });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  signIn(['overview', 'devices', 'alarms', 'replay']);
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetServerClock();
});

describe('ход перепрогона', () => {
  it('пока список едет, показывается заглушка', async () => {
    stand.listHold = new Promise(() => undefined);
    show();

    expect(
      await screen.findByRole('status', { name: 'Загружаем перепрогоны' }),
    ).toBeInTheDocument();
  });

  it('ошибка списка объяснена, а повтор возвращает экран', async () => {
    stand.listStatus = 503;
    show();

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер недоступен');

    stand.listStatus = 200;
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByRole('region', { name: 'Новый перепрогон' })).toBeInTheDocument();
    expect(await screen.findByText('Перепрогонов ещё не было')).toBeInTheDocument();
  });

  it('ход идёт по смещениям, полоса не выходит за сто процентов, опрос стоит после итога', async () => {
    fakeClock();
    const queued = run();
    stand.active = queued;
    stand.runs = [queued];
    stand.progress = [
      queued,
      run({
        status: 'running',
        groupId: GROUP,
        startedAt: at(-59_000),
        progress: progress(8_000, 2_000),
      }),
      run({
        status: 'running',
        groupId: GROUP,
        startedAt: at(-59_000),
        progress: progress(8_000, 8_600),
      }),
      DONE,
    ];
    show();

    const scope = await panel();
    expect(await scope.findByText('в очереди')).toBeInTheDocument();
    expect(scope.getByText('Ждёт, пока процессор заберёт прогон')).toBeInTheDocument();

    await pass(RUN_POLL_MS);
    const bar = await scope.findByRole('progressbar', { name: 'Прочитано смещений окна' });
    await waitFor(() => {
      expect(bar).toHaveAttribute('aria-valuenow', '25');
    });
    expect(scope.getByText(/^Прочитано 2\s000 из 8\s000 смещений, 25%/)).toBeInTheDocument();
    expect(scope.getByText(GROUP)).toBeInTheDocument();
    expect(scope.getByRole('link', { name: 'Конвейер' })).toHaveAttribute('href', '/pipeline');

    await pass(RUN_POLL_MS);
    await waitFor(() => {
      expect(scope.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    });
    expect(scope.getByText(/^Прочитано 8\s000 из 8\s000 смещений, 100%/)).toBeInTheDocument();

    const listReads = readsOf('/api/replay-runs');
    await pass(RUN_POLL_MS);
    expect(await scope.findByText(/^Перепрогон готов за /)).toBeInTheDocument();
    expect(scope.getByText('готово')).toBeInTheDocument();
    await waitFor(() => {
      expect(readsOf('/api/replay-runs')).toBeGreaterThan(listReads);
    });

    const polls = readsOf(`/api/replay-runs/${RUN_ID}`);
    expect(polls).toBe(4);
    await pass(RUN_POLL_MS * 3);
    expect(readsOf(`/api/replay-runs/${RUN_ID}`)).toBe(polls);
  });

  it('долгое ожидание в очереди честно объяснено', async () => {
    const waiting = run({ createdAt: at(-12_000) });
    stand.active = waiting;
    stand.runs = [waiting];
    stand.progress = [waiting];
    show();

    const scope = await panel();

    expect(await scope.findByText(/^Прогон ждёт процессор дольше 5 с\./)).toHaveTextContent(
      'перепрогон на стенде выключен или процессор не запущен',
    );
    expect(scope.getByText(/в очереди 0:12$/)).toBeInTheDocument();
  });

  it('прогона по адресу нет: сказано словами и есть путь к последнему', async () => {
    show(`/replay?run=${RUN_ID}`);

    expect(await screen.findByText('Прогон не найден')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Показать последний' })).toBeInTheDocument();
  });

  it('временная ошибка опроса прогона не из списка видна, а не прячется за заглушкой', async () => {
    stand.progress = [503, DONE];
    fakeClock();
    show(`/replay?run=${RUN_ID}`);

    expect(await screen.findByText('Прогон спросим снова через секунду.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Сервер недоступен');
    expect(screen.queryByRole('status', { name: 'Загружаем прогон' })).toBeNull();

    await pass(RUN_POLL_MS);
    expect(await (await panel()).findByText('готово')).toBeInTheDocument();
    expect(screen.queryByText('Прогон спросим снова через секунду.')).toBeNull();
  });

  it('проваленный прогон показывает причину', async () => {
    stand.runs = [
      run({
        status: 'failed',
        error: 'процессор остановлен посреди перепрогона',
        finishedAt: at(-1_000),
      }),
    ];
    show();

    const scope = await panel();

    expect(await scope.findByRole('alert')).toHaveTextContent(
      'Перепрогон не выполнен: процессор остановлен посреди перепрогона',
    );
    expect(screen.queryByRole('region', { name: 'Разница срабатываний' })).toBeNull();
  });
});

describe('итог перепрогона', () => {
  it('таблица разницы, изменённые уставки и график выбранной строки', async () => {
    stand.runs = [DONE];
    show();

    const scope = await result();
    const table = within(
      await scope.findByRole('region', { name: 'Таблица разницы срабатываний' }),
    );

    expect(table.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Прибор',
      'Параметр',
      'Режим',
      'Было',
      'Стало',
      'Новые',
      'Пропали',
      'Вживую',
    ]);
    const rows = table.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    await waitFor(() => {
      expect(
        within(rows[0]!)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      ).toEqual(['Температура испарителя', 'оттайка', '0', '2', '+2', '0', '0']);
    });
    expect(
      scope.getByText('Температура испарителя, оттайка: верхняя граница 12 → 8 · 2 прибора'),
    ).toBeInTheDocument();
    expect(scope.queryByText(/Кадры есть не с начала окна/)).toBeNull();

    const first = table.getByRole('button', {
      name: 'График: RC-101, Температура испарителя, оттайка',
    });
    expect(first).toHaveAttribute('aria-pressed', 'true');

    await screen.findByTestId('chart');
    await waitFor(() => {
      expect(lastChart().bands).toHaveLength(2);
    });
    expect(lastChart().bands.every((band) => band.track === 'bottom')).toBe(true);
    expect(lastChart().bands[1]?.to).toBe(Date.parse(DONE.coveredTo ?? '') / 1000);
    expect(lastChart().thresholds.map((line) => [line.value, line.dashed])).toEqual([
      [-28, true],
      [12, true],
      [8, false],
    ]);
    expect(lastChart().label).toMatch(/Эпизодов с прежними уставками 0, с правкой 2/);
    expect(scope.getByText('стало, дорожка снизу: 2 эпизода')).toBeInTheDocument();
    expect(scope.getByText('верхняя граница до правки 12')).toBeInTheDocument();
    expect(scope.getByText('верхняя граница после правки 8')).toBeInTheDocument();

    await userEvent.click(
      table.getByRole('button', { name: 'График: RC-102, Температура испарителя, оттайка' }),
    );

    await waitFor(() => {
      expect(lastChart().bands).toHaveLength(1);
    });
    expect(
      readsStarting(
        `/api/replay-runs/${RUN_ID}/episodes?deviceCode=RC-102&metricKey=evap_temp_c&mode=defrost`,
      ),
    ).toBe(1);
    expect(first).toHaveAttribute('aria-pressed', 'false');
  });

  it('пустая разница названа словами', async () => {
    stand.runs = [DONE];
    stand.diff = { ...DIFF, rows: [] };
    show();

    const scope = await result();

    expect(await scope.findByText('Правка не изменила ни одного срабатывания')).toBeInTheDocument();
    expect(scope.queryByRole('region', { name: 'Таблица разницы срабатываний' })).toBeNull();
  });

  it('кадры не с начала окна дают честную строку покрытия', async () => {
    const late = { ...DONE, coveredFrom: at(-1_800_000) };
    stand.runs = [late];
    stand.diff = { ...DIFF, run: late };
    show();

    const scope = await result();

    expect(await scope.findByRole('note')).toHaveTextContent(
      /^Кадры есть не с начала окна: покрытие с /,
    );
  });

  it('прогон без смещений в окне это отдельное состояние «в окне нет кадров»', async () => {
    const empty = run({
      status: 'done',
      progress: { offsetsTotal: 0, offsetsDone: 0, framesMatched: 0, framesRejected: 0 },
      startedAt: at(-50_000),
      finishedAt: at(-49_000),
    });
    stand.runs = [empty];
    show();

    const scope = await result();

    expect(await scope.findByText('В окне нет кадров')).toBeInTheDocument();
    expect(
      (await panel()).getByText(/^В окне нет кадров: брокер не хранит сырых кадров/),
    ).toBeInTheDocument();
    expect(readsStarting(`/api/replay-runs/${RUN_ID}/diff`)).toBe(0);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('смещения в окне есть, а кадров выбранных приборов нет: разница не запрашивается', async () => {
    stand.runs = [{ ...DONE, coveredFrom: null, coveredTo: null }];
    show();

    const scope = await result();

    expect(await scope.findByText('Кадров выбранных приборов в окне нет')).toBeInTheDocument();
    expect(readsStarting(`/api/replay-runs/${RUN_ID}/diff`)).toBe(0);
  });

  it('эпизоды «было» ложатся на верхнюю дорожку', async () => {
    stand.runs = [DONE];
    stand.baseline = (deviceCode) => [episode(deviceCode, at(-3_300_000), at(-3_240_000))];
    show();

    await result();
    await screen.findByTestId('chart');
    await waitFor(() => {
      expect(lastChart().bands).toHaveLength(3);
    });
    expect(lastChart().bands.map((band) => band.track)).toEqual(['top', 'bottom', 'bottom']);
    expect(lastChart().label).toMatch(/Эпизодов с прежними уставками 1, с правкой 2/);
  });

  it('без показаний за окно график пуст, а повтор перечитывает кривую', async () => {
    stand.runs = [DONE];
    stand.series = { ...SERIES, metrics: [{ metricKey: 'evap_temp_c', points: [] }] };
    show();

    const scope = await result();
    expect(
      await scope.findByText('За окно прогона показаний этого параметра в базе нет'),
    ).toBeInTheDocument();
    const reads = readsStarting('/api/devices/RC-101/series');

    stand.series = SERIES;
    await userEvent.click(scope.getByRole('button', { name: 'Повторить' }));

    await screen.findByTestId('chart');
    expect(readsStarting('/api/devices/RC-101/series')).toBe(reads + 1);
  });

  it('ошибка чтения разницы объяснена, а повтор возвращает таблицу', async () => {
    stand.runs = [DONE];
    stand.diff = 503;
    show();

    const scope = await result();
    expect(await scope.findByRole('alert')).toHaveTextContent('Сервер недоступен');

    stand.diff = DIFF;
    await userEvent.click(scope.getByRole('button', { name: 'Повторить' }));

    expect(
      await scope.findByRole('region', { name: 'Таблица разницы срабатываний' }),
    ).toBeInTheDocument();
  });
});
