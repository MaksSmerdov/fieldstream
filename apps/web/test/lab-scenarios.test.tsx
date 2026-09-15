import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  labFaultsResponseSchema,
  labLinesResponseSchema,
  scenarioRunRequestSchema,
  scenarioRunSchema,
  scenarioSummarySchema,
  scenariosResponseSchema,
  topologyResponseSchema,
} from '@fieldstream/contracts';
import type {
  ModuleId,
  ScenarioRun,
  ScenarioRunStep,
  ScenarioStepKind,
  ScenarioStepStatus,
  ScenarioSummary,
} from '@fieldstream/contracts';
import { RUN_POLL_MS } from '../src/features/lab/hooks/scenarios/useScenarioRun.js';
import { LabPage } from '../src/pages/LabPage.js';
import { useSessionStore } from '../src/shared/auth/session-store.js';
import { resetServerClock } from '../src/shared/time/serverClock.js';

const SERVER_TIME = '2026-02-11T10:00:00.000Z';
const RUN_ID = '5f0c2a8e-3b1d-4c6f-9a7e-2d4b6c8e0f11';
const FOREIGN_ID = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ENGINEER = 'engineer@fieldstream.local';
const CI = 'ci@fieldstream.local';
const BUSY_MESSAGE = `на стенде идёт прогон «Обрыв линии», его запустил ${CI}: дождитесь итога и повторите запуск`;

const at = (offsetMs: number): string => new Date(Date.parse(SERVER_TIME) + offsetMs).toISOString();

const DEAD_STEPS = [
  'внести поломку «молчит» на RC-105',
  'дождаться, пока размыкатель RC-105 разомкнётся',
  'снять поломку «молчит» с RC-105',
];

const BLACKOUT_STEPS = [
  'внести обрыв порта линии L3',
  'дождаться, пока приборы линии L3 уйдут в offline',
  'снять обрыв порта линии L3',
];

const STEP_KINDS: readonly ScenarioStepKind[] = ['inject', 'waitFor', 'clear'];

type StepState = readonly [ScenarioStepStatus, string | null];

const PENDING: StepState = ['pending', null];

/** Шаги прогона по заголовкам: статус и пояснение задаются по номеру, остальные ждут. */
const stepsOf = (titles: readonly string[], states: readonly StepState[]): ScenarioRunStep[] =>
  titles.map((title, index) => {
    const [status, detail] = states[index] ?? PENDING;

    return {
      index,
      kind: STEP_KINDS[index] ?? 'hold',
      title,
      status,
      startedAt: status === 'pending' || status === 'skipped' ? null : SERVER_TIME,
      finishedAt: status === 'passed' || status === 'failed' ? at(1_000) : null,
      detail,
    };
  });

/** Прогон, прошедший схему контракта. */
const run = (patch: Partial<ScenarioRun> = {}): ScenarioRun =>
  scenarioRunSchema.parse({
    id: RUN_ID,
    scenario: 'dead-device',
    title: 'Мёртвый прибор',
    source: 'ui',
    requestedBy: ENGINEER,
    status: 'queued',
    steps: stepsOf(DEAD_STEPS, []),
    error: null,
    createdAt: SERVER_TIME,
    startedAt: null,
    finishedAt: null,
    ...patch,
  });

const DEAD: ScenarioSummary = scenarioSummarySchema.parse({
  name: 'dead-device',
  title: 'Мёртвый прибор',
  description:
    'Контроллер RC-105 перестаёт отвечать, размыкатель отсекает его, а соседи опрашиваются в прежнем темпе.',
  timeoutSec: 360,
  steps: DEAD_STEPS,
  lastRun: run({
    id: '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70',
    source: 'ci',
    requestedBy: CI,
    status: 'passed',
    steps: stepsOf(DEAD_STEPS, [
      ['passed', null],
      ['passed', null],
      ['passed', null],
    ]),
    createdAt: at(-400_000),
    startedAt: at(-400_000),
    finishedAt: at(-180_000),
  }),
});

const BLACKOUT: ScenarioSummary = scenarioSummarySchema.parse({
  name: 'line-blackout',
  title: 'Обрыв линии',
  description: 'Порт линии L3 пропадает, приборы линии уходят в offline, соседняя линия работает.',
  timeoutSec: 540,
  steps: BLACKOUT_STEPS,
  lastRun: run({
    id: 'c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f',
    scenario: 'line-blackout',
    title: 'Обрыв линии',
    status: 'failed',
    steps: stepsOf(BLACKOUT_STEPS, [
      ['passed', null],
      ['failed', 'приборы линии L3 не ушли в offline за 120 с'],
      ['passed', null],
    ]),
    error: 'приборы линии L3 не ушли в offline за 120 с',
    createdAt: at(-7_400_000),
    startedAt: at(-7_400_000),
    finishedAt: at(-7_200_000),
  }),
});

const CRC: ScenarioSummary = scenarioSummarySchema.parse({
  name: 'crc-garbage',
  title: 'Мусор в кадре',
  description: 'Контроллер RC-101 отвечает кадрами с битой контрольной суммой.',
  timeoutSec: 210,
  steps: ['внести поломку «мусор в кадре» на RC-101', 'снять поломку с RC-101'],
  lastRun: null,
});

const FOREIGN: ScenarioRun = run({
  id: FOREIGN_ID,
  scenario: 'line-blackout',
  title: 'Обрыв линии',
  source: 'ci',
  requestedBy: CI,
  status: 'running',
  steps: stepsOf(BLACKOUT_STEPS, [
    ['passed', 'обрыв внесён'],
    ['running', 'в offline ушли 2 прибора из 4'],
  ]),
  createdAt: at(-66_000),
  startedAt: at(-65_000),
});

const TOPOLOGY = topologyResponseSchema.parse({ serverTime: SERVER_TIME, sites: [] });

interface Stand {
  scenarios: readonly ScenarioSummary[];
  active: ScenarioRun | null;
  listStatus: number;
  listHold: Promise<void>;
  launchStatus: number;
  progress: ScenarioRun[];
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

/** Ответы шлюза по адресам: прогон занимает стенд, пока его ход не дойдёт до итога. */
const route = async (path: string, init?: RequestInit): Promise<Response> => {
  const method = init?.method ?? 'GET';
  const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  calls.push({ method, path, body });
  const url = new URL(path, 'http://stand');

  if (url.pathname === '/api/topology') return reply(200, TOPOLOGY);

  if (url.pathname === '/api/lab/lines') {
    return reply(200, labLinesResponseSchema.parse({ serverTime: SERVER_TIME, lines: [] }));
  }

  if (url.pathname === '/api/lab/faults') {
    return reply(200, labFaultsResponseSchema.parse({ serverTime: SERVER_TIME, faults: [] }));
  }

  if (url.pathname === '/api/scenarios') {
    await stand.listHold;
    return stand.listStatus === 200
      ? reply(
          200,
          scenariosResponseSchema.parse({
            serverTime: SERVER_TIME,
            scenarios: stand.scenarios,
            activeRun: stand.active,
          }),
        )
      : reply(stand.listStatus, { message: 'шлюз недоступен' });
  }

  const launch = /^\/api\/scenarios\/([a-z0-9-]+)\/run$/.exec(url.pathname);
  if (launch !== null && method === 'POST') {
    const request = scenarioRunRequestSchema.parse(body);
    if (stand.launchStatus === 409) {
      stand.active = FOREIGN;
      return reply(409, { statusCode: 409, message: BUSY_MESSAGE, error: 'Conflict' });
    }
    const accepted = run({ scenario: launch[1]!, source: request.source });
    stand.active = accepted;
    return reply(202, accepted);
  }

  if (url.pathname.startsWith('/api/scenario-runs/')) {
    const next = stand.progress.length > 1 ? stand.progress.shift() : stand.progress[0];
    if (next === undefined) return reply(404, { message: 'прогона нет' });
    if (next.status === 'passed' || next.status === 'failed') {
      stand.active = null;
      stand.scenarios = stand.scenarios.map((item) =>
        item.name === next.scenario ? { ...item, lastRun: next } : item,
      );
    }
    return reply(200, next);
  }

  return reply(404, { message: 'нет такого адреса' });
};

const readsOf = (path: string): number =>
  calls.filter((call) => call.method === 'GET' && call.path === path).length;

const launches = (): Call[] => calls.filter((call) => call.method === 'POST');

let client: QueryClient;

const signIn = (permissions: readonly ModuleId[]): void => {
  useSessionStore.setState({
    accessToken: 'токен',
    expiresAt: '2026-02-11T11:00:00.000Z',
    user: {
      id: 'ba0ba102-a143-4f6c-8538-47bded9939fb',
      email: ENGINEER,
      displayName: 'Инженер',
      role: permissions.includes('scenarios.run') ? 'engineer' : 'viewer',
      permissions: [...permissions],
    },
    checked: true,
  });
};

const show = (): void => {
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/lab']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  render(<LabPage />, { wrapper });
};

/** Раздел сценариев на экране отказов. */
const section = async () => within(await screen.findByRole('region', { name: 'Сценарии' }));

/** Карточка сценария по заголовку. */
const card = async (title: string) =>
  within(await (await section()).findByRole('article', { name: title }));

type User = ReturnType<typeof userEvent.setup>;

/** Поддельные часы идут вместе с настоящими, но опрос можно промотать. */
const fakeClock = (): User => {
  vi.useFakeTimers({ shouldAdvanceTime: true });

  return userEvent.setup({
    advanceTimers: (ms) => {
      vi.advanceTimersByTime(ms);
    },
  });
};

/** Проматывает поддельные часы так, чтобы React успел отрисовать пришедшие ответы. */
const pass = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** Запуск сценария из карточки с подтверждением в диалоге. */
const confirmLaunch = async (user: User, title: string): Promise<void> => {
  const scenario = await card(title);
  await user.click(scenario.getByRole('button', { name: 'Запустить' }));
  const dialog = within(await screen.findByRole('dialog', { name: `Запустить «${title}»?` }));
  await user.click(dialog.getByRole('button', { name: 'Запустить' }));
};

beforeEach(() => {
  calls = [];
  stand = {
    scenarios: [DEAD, BLACKOUT, CRC],
    active: null,
    listStatus: 200,
    listHold: Promise.resolve(),
    launchStatus: 202,
    progress: [],
  };
  Object.defineProperty(globalThis, 'fetch', { writable: true, value: vi.fn(route) });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  signIn(['overview', 'devices', 'alarms', 'lab', 'lab.inject', 'scenarios.run']);
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetServerClock();
});

describe('сценарии стенда на экране отказов', () => {
  it('пока список едет, показывается заглушка', async () => {
    stand.listHold = new Promise(() => undefined);
    show();

    const scenarios = await section();

    expect(scenarios.getByRole('status', { name: 'Загружаем сценарии' })).toBeInTheDocument();
  });

  it('карточки показывают описание, предел, шаги и бейджи последних прогонов', async () => {
    show();

    const scenarios = await section();
    const dead = within(await scenarios.findByRole('article', { name: 'Мёртвый прибор' }));
    expect(scenarios.getAllByRole('article')).toHaveLength(3);

    expect(dead.getByText(/Контроллер RC-105 перестаёт отвечать/)).toBeInTheDocument();
    expect(dead.getByText('dead-device · до 6 минут')).toBeInTheDocument();
    expect(dead.getByText('прошёл').closest('.MuiChip-root')).toHaveClass('MuiChip-colorSuccess');
    expect(dead.getByText('3 мин назад')).toBeInTheDocument();
    expect(dead.getByText(/из CI/)).toBeInTheDocument();

    const toggle = dead.getByRole('button', { name: 'Показать шаги (3)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAccessibleDescription('Мёртвый прибор');
    expect(dead.getByRole('button', { name: 'Запустить' })).toHaveAccessibleDescription(
      'Мёртвый прибор',
    );
    expect(dead.queryByRole('list', { name: 'Шаги сценария «Мёртвый прибор»' })).toBeNull();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAccessibleName('Скрыть шаги (3)');
    const steps = within(dead.getByRole('list', { name: 'Шаги сценария «Мёртвый прибор»' }));
    expect(steps.getAllByRole('listitem').map((item) => item.textContent)).toEqual(DEAD_STEPS);

    const blackout = within(scenarios.getByRole('article', { name: 'Обрыв линии' }));
    expect(blackout.getByText('line-blackout · до 9 минут')).toBeInTheDocument();
    expect(blackout.getByText('провален').closest('.MuiChip-root')).toHaveClass(
      'MuiChip-colorError',
    );
    expect(blackout.getByText('2 ч назад')).toBeInTheDocument();
    expect(blackout.getByText(/из интерфейса/)).toBeInTheDocument();

    const crc = within(scenarios.getByRole('article', { name: 'Мусор в кадре' }));
    expect(crc.getByText('crc-garbage · до 4 минут')).toBeInTheDocument();
    expect(crc.getByText('ещё не запускался')).toBeInTheDocument();

    for (const button of scenarios.getAllByRole('button', { name: 'Запустить' })) {
      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute('aria-disabled');
    }
    expect(scenarios.queryByRole('region', { name: /^Прогон/ })).toBeNull();
  });

  it('ошибка списка объяснена, а повтор возвращает сценарии', async () => {
    stand.listStatus = 503;
    show();

    const scenarios = await section();
    expect(await scenarios.findByRole('alert')).toHaveTextContent('Сервер недоступен');

    stand.listStatus = 200;
    await userEvent.click(scenarios.getByRole('button', { name: 'Повторить' }));

    expect(await scenarios.findByRole('article', { name: 'Мёртвый прибор' })).toBeInTheDocument();
    expect(scenarios.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('пустой каталог объяснён словами', async () => {
    stand.scenarios = [];
    show();

    const scenarios = await section();

    expect(await scenarios.findByText('Сценариев нет')).toBeInTheDocument();
    expect(scenarios.getByRole('button', { name: 'Перечитать сценарии' })).toBeInTheDocument();
    expect(scenarios.queryByRole('article')).toBeNull();
  });

  it('отказ маршрута сценариев показан ошибкой с повтором', async () => {
    stand.listStatus = 404;
    show();

    const scenarios = await section();
    expect(await scenarios.findByRole('alert')).toHaveTextContent('Запрос не удался');

    stand.listStatus = 200;
    await userEvent.click(scenarios.getByRole('button', { name: 'Повторить' }));

    expect(await scenarios.findByRole('article', { name: 'Мёртвый прибор' })).toBeInTheDocument();
    expect(scenarios.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('без права запуска кнопки недоступны и это объяснено', async () => {
    signIn(['overview', 'devices', 'alarms', 'lab', 'lab.inject']);
    show();

    const scenarios = await section();
    await scenarios.findByRole('article', { name: 'Мёртвый прибор' });

    expect(scenarios.getByRole('note')).toHaveTextContent('Запускать сценарии может инженер');
    const buttons = scenarios.getAllByRole('button', { name: 'Запустить' });
    expect(buttons).toHaveLength(3);
    for (const button of buttons) expect(button).toBeDisabled();
    expect(launches()).toEqual([]);
  });

  it('во время чужого прогона запуск недоступен с пояснением, а ход прогона виден', async () => {
    stand.active = FOREIGN;
    stand.progress = [FOREIGN];
    stand.scenarios = [DEAD, { ...BLACKOUT, lastRun: FOREIGN }, CRC];
    show();

    const scenarios = await section();
    const panel = within(await scenarios.findByRole('region', { name: 'Прогон «Обрыв линии»' }));
    expect(
      await panel.findByText(/^запустил ci@fieldstream\.local из CI · прошло 1:0[56]$/),
    ).toBeInTheDocument();

    const items = panel.getAllByRole('listitem');
    expect(items[0]).not.toHaveAttribute('aria-current');
    expect(within(items[0]!).getByText('пройден')).toBeInTheDocument();
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(within(items[1]!).getByText('идёт')).toBeInTheDocument();
    expect(within(items[1]!).getByText('в offline ушли 2 прибора из 4')).toBeInTheDocument();
    expect(within(items[2]!).getByText('ждёт')).toBeInTheDocument();

    const dead = within(scenarios.getByRole('article', { name: 'Мёртвый прибор' }));
    const button = dead.getByRole('button', { name: 'Запустить' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription(
      'Мёртвый прибор Сейчас идёт «Обрыв линии»: запуск станет доступен после его итога.',
    );

    const blackout = within(scenarios.getByRole('article', { name: 'Обрыв линии' }));
    expect(blackout.getByText('идёт').closest('.MuiChip-root')).toHaveClass('MuiChip-colorPrimary');
    expect(blackout.getByRole('button', { name: 'Запустить' })).toHaveAccessibleDescription(
      'Обрыв линии Этот сценарий идёт сейчас, ход виден выше.',
    );

    await userEvent.click(button);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(launches()).toEqual([]);
  });

  it('запуск спрашивает подтверждение и только после него шлёт запрос', async () => {
    const user = userEvent.setup();
    stand.progress = [
      run({
        status: 'running',
        startedAt: SERVER_TIME,
        steps: stepsOf(DEAD_STEPS, [['running', null]]),
      }),
    ];
    show();

    const dead = await card('Мёртвый прибор');
    await user.click(dead.getByRole('button', { name: 'Запустить' }));

    const dialog = within(
      await screen.findByRole('dialog', { name: 'Запустить «Мёртвый прибор»?' }),
    );
    expect(
      dialog.getByText(/^Сценарий вносит настоящие поломки на стенд и идёт до 6 минут\./),
    ).toBeInTheDocument();

    await user.click(dialog.getByRole('button', { name: 'Отмена' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(launches()).toEqual([]);

    await confirmLaunch(user, 'Мёртвый прибор');

    await waitFor(() => {
      expect(launches()).toEqual([
        { method: 'POST', path: '/api/scenarios/dead-device/run', body: { source: 'ui' } },
      ]);
    });
    await waitFor(() => {
      expect(dead.getByRole('button', { name: 'Запустить' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });
    expect(dead.getByRole('button', { name: 'Запустить' })).toHaveAccessibleDescription(
      'Мёртвый прибор Этот сценарий идёт сейчас, ход виден выше.',
    );
  });

  it('ход прогона виден по шагам до итога, затем опрос стоит, а список перечитан', async () => {
    const user = fakeClock();
    stand.progress = [
      run({
        status: 'running',
        startedAt: SERVER_TIME,
        steps: stepsOf(DEAD_STEPS, [['running', null]]),
      }),
      run({
        status: 'running',
        startedAt: SERVER_TIME,
        steps: stepsOf(DEAD_STEPS, [
          ['passed', 'поломка внесена'],
          ['running', 'размыкатель RC-105 пока замкнут, отказов 1'],
        ]),
      }),
      run({
        status: 'passed',
        startedAt: SERVER_TIME,
        finishedAt: at(2_000),
        steps: stepsOf(DEAD_STEPS, [
          ['passed', 'поломка внесена'],
          ['passed', 'размыкатель разомкнулся за 1,2 с'],
          ['passed', null],
        ]),
      }),
    ];
    show();

    await confirmLaunch(user, 'Мёртвый прибор');

    const scenarios = await section();
    const panel = within(await scenarios.findByRole('region', { name: 'Прогон «Мёртвый прибор»' }));
    const items = (): HTMLElement[] => panel.getAllByRole('listitem');
    expect(panel.getByText('в очереди')).toBeInTheDocument();
    expect(items().filter((item) => item.hasAttribute('aria-current'))).toEqual([]);

    await pass(RUN_POLL_MS);
    await waitFor(() => {
      expect(items()[0]).toHaveAttribute('aria-current', 'step');
    });
    expect(
      await panel.findByText(/^запустил engineer@fieldstream\.local из интерфейса · прошло 0:0\d$/),
    ).toBeInTheDocument();

    await pass(RUN_POLL_MS);
    await waitFor(() => {
      expect(items()[1]).toHaveAttribute('aria-current', 'step');
    });
    expect(items()[0]).not.toHaveAttribute('aria-current');
    expect(within(items()[0]!).getByText('пройден')).toBeInTheDocument();
    expect(within(items()[0]!).getByText('поломка внесена')).toBeInTheDocument();
    expect(
      within(items()[1]!).getByText('размыкатель RC-105 пока замкнут, отказов 1'),
    ).toBeInTheDocument();
    expect(within(items()[2]!).getByText('ждёт')).toBeInTheDocument();

    const dead = await card('Мёртвый прибор');
    expect(dead.getByRole('button', { name: 'Запустить' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    const listReads = readsOf('/api/scenarios');
    await pass(RUN_POLL_MS);

    expect(await panel.findByText('Сценарий прошёл за 0:02')).toBeInTheDocument();
    expect(panel.getByText('длился 0:02', { exact: false })).toBeInTheDocument();
    await waitFor(() => {
      expect(readsOf('/api/scenarios')).toBeGreaterThan(listReads);
    });
    await waitFor(() => {
      expect(dead.getByRole('button', { name: 'Запустить' })).not.toHaveAttribute('aria-disabled');
    });
    expect(dead.getByText(/из интерфейса/)).toBeInTheDocument();
    expect(readsOf(`/api/scenario-runs/${RUN_ID}`)).toBe(3);

    await pass(RUN_POLL_MS * 3);

    expect(readsOf(`/api/scenario-runs/${RUN_ID}`)).toBe(3);
    expect(panel.getByRole('button', { name: 'Скрыть итог' })).toBeInTheDocument();
  });

  it('занятый стенд при запуске объяснён текстом до итога чужого прогона', async () => {
    const user = fakeClock();
    stand.launchStatus = 409;
    stand.progress = [FOREIGN];
    show();

    await confirmLaunch(user, 'Мёртвый прибор');

    const dead = await card('Мёртвый прибор');
    expect(await dead.findByRole('alert')).toHaveTextContent(`Стенд занят: ${BUSY_MESSAGE}`);
    await waitFor(() => {
      expect(dead.getByRole('button', { name: 'Запустить' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });
    expect(dead.getByRole('button', { name: 'Запустить' })).toHaveAccessibleDescription(
      'Мёртвый прибор Сейчас идёт «Обрыв линии»: запуск станет доступен после его итога.',
    );
    expect(
      await (await section()).findByRole('region', { name: 'Прогон «Обрыв линии»' }),
    ).toBeInTheDocument();

    stand.progress = [
      run({
        ...FOREIGN,
        status: 'passed',
        finishedAt: at(0),
        steps: stepsOf(BLACKOUT_STEPS, [
          ['passed', 'обрыв внесён'],
          ['passed', 'в offline ушли 4 прибора из 4'],
          ['passed', null],
        ]),
      }),
    ];
    await pass(RUN_POLL_MS);

    await waitFor(() => {
      expect(dead.getByRole('button', { name: 'Запустить' })).not.toHaveAttribute('aria-disabled');
    });
    expect(dead.queryByRole('alert')).not.toBeInTheDocument();
    expect(dead.getByRole('button', { name: 'Запустить' })).toHaveAccessibleDescription(
      'Мёртвый прибор',
    );
  });

  it('без хода прогона карточка не ссылается на панель, а скрытый итог отдаёт фокус разделу', async () => {
    const user = userEvent.setup();
    stand.active = FOREIGN;
    stand.scenarios = [DEAD, { ...BLACKOUT, lastRun: FOREIGN }, CRC];
    show();

    const scenarios = await section();
    const panel = within(await scenarios.findByRole('region', { name: 'Прогон «Обрыв линии»' }));
    expect(
      await panel.findByText(/^Ход прогона больше не узнать: прогона нет\./),
    ).toBeInTheDocument();

    const blackout = within(scenarios.getByRole('article', { name: 'Обрыв линии' }));
    const waiting =
      'Обрыв линии Этот сценарий идёт сейчас: запуск станет доступен после его итога.';
    expect(blackout.getByRole('button', { name: 'Запустить' })).toHaveAccessibleDescription(
      waiting,
    );

    await user.click(panel.getByRole('button', { name: 'Скрыть итог' }));

    expect(scenarios.queryByRole('region', { name: /^Прогон/ })).toBeNull();
    expect(scenarios.getByRole('heading', { level: 2, name: 'Сценарии' })).toHaveFocus();
    expect(blackout.getByRole('button', { name: 'Запустить' })).toHaveAccessibleDescription(
      waiting,
    );
  });
});
