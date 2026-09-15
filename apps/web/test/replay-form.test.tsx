import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alarmRulesResponseSchema,
  deviceProfileViewSchema,
  replayRequestSchema,
  replayRunSchema,
  replayRunsResponseSchema,
  topologyResponseSchema,
} from '@fieldstream/contracts';
import type { AlarmRuleView, ModuleId, ReplayRun } from '@fieldstream/contracts';
import { INITIAL_FORM, evaluateForm } from '../src/features/replay/replay-form.js';
import type { FormContext, PatchDraft, RuleCatalog } from '../src/features/replay/replay-form.js';
import { useSessionStore } from '../src/shared/auth/session-store.js';
import { resetServerClock } from '../src/shared/time/serverClock.js';

vi.mock('../src/shared/charts/TimeChart/TimeChart.js', () => ({
  TimeChart: () => <div data-testid="chart" />,
}));

const { ReplayPage } = await import('../src/pages/ReplayPage.js');

const SERVER_TIME = '2026-02-11T10:00:00.000Z';
const RUN_ID = '5f0c2a8e-3b1d-4c6f-9a7e-2d4b6c8e0f11';
const FOREIGN_ID = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ENGINEER = 'engineer@fieldstream.local';
const CI = 'ci@fieldstream.local';
const RETENTION_MS = 604_800_000;
const BUSY_MESSAGE = `на стенде уже идёт перепрогон, его поставил ${CI}: дождитесь итога`;

const at = (offsetMs: number): string => new Date(Date.parse(SERVER_TIME) + offsetMs).toISOString();

/** Прибор дерева объектов. */
const device = (code: string, slaveId: number, profileKey: string) => ({
  code,
  label: profileKey === 'rc-2000' ? `Камера ${code}` : `Счётчик ${code}`,
  profileKey,
  profileVersion: 1,
  slaveId,
  enabled: true,
  status: 'online',
  reason: 'ok',
  mode: 'cooling',
  since: SERVER_TIME,
  lastOkAt: SERVER_TIME,
  activeAlarms: 0,
  worstSeverity: null,
  stale: false,
  staleSince: null,
});

const TOPOLOGY = topologyResponseSchema.parse({
  serverTime: SERVER_TIME,
  sites: [
    {
      code: 'SITE-A',
      name: 'Site Alpha',
      timezone: 'Europe/Moscow',
      gateways: [
        {
          code: 'GW-01',
          host: '192.0.2.11',
          lines: [
            {
              code: 'L1',
              baud: 19200,
              pollIntervalMs: 10_000,
              requestTimeoutMs: 600,
              planMode: 'merged',
              enabled: true,
              devices: [
                device('RC-101', 1, 'rc-2000'),
                device('RC-102', 2, 'rc-2000'),
                device('PM-201', 4, 'pm-3phase'),
              ],
            },
          ],
        },
      ],
    },
  ],
});

const rule = (patch: Partial<AlarmRuleView>): AlarmRuleView => ({
  metricKey: 'evap_temp_c',
  mode: 'defrost',
  minValue: -28,
  maxValue: 12,
  hysteresis: 1,
  debounceCycles: 6,
  severity: 'info',
  enabled: true,
  updatedBy: null,
  updatedAt: at(-86_400_000),
  ...patch,
});

const CHAMBER_RULES = [
  rule({}),
  rule({ mode: 'cooling', maxValue: 0, debounceCycles: 3 }),
  rule({ metricKey: 'supply_temp_c', mode: 'cooling', maxValue: 2, debounceCycles: 3 }),
];

const METER_RULES = [
  rule({ metricKey: 'voltage_l1_v', mode: 'cooling', minValue: 207, maxValue: 243 }),
];

const param = (metricKey: string, label: string, unit: string) => ({
  metricKey,
  label,
  unit,
  precision: 1,
  kind: 'number',
  states: null,
  bits: null,
  range: null,
});

const profileOf = (code: string) =>
  deviceProfileViewSchema.parse(
    code.startsWith('RC')
      ? {
          deviceCode: code,
          profileKey: 'rc-2000',
          profileVersion: 1,
          label: 'Холодильный контроллер RC-2000',
          sections: [
            {
              key: 'temps',
              label: 'Температуры',
              params: [
                param('supply_temp_c', 'Температура подачи', '°C'),
                param('evap_temp_c', 'Температура испарителя', '°C'),
              ],
            },
          ],
        }
      : {
          deviceCode: code,
          profileKey: 'pm-3phase',
          profileVersion: 1,
          label: 'Счётчик PM-3',
          sections: [
            {
              key: 'power',
              label: 'Сеть',
              params: [param('voltage_l1_v', 'Напряжение L1', 'В')],
            },
          ],
        },
  );

/** Прогон, прошедший схему контракта. */
const run = (patch: Partial<ReplayRun> = {}): ReplayRun =>
  replayRunSchema.parse({
    id: RUN_ID,
    status: 'queued',
    requestedBy: ENGINEER,
    from: at(-900_000),
    to: SERVER_TIME,
    deviceCodes: ['RC-101', 'RC-102'],
    patches: [{ metricKey: 'evap_temp_c', mode: 'defrost', maxValue: 8 }],
    progress: { offsetsTotal: 0, offsetsDone: 0, framesMatched: 0, framesRejected: 0 },
    coveredFrom: null,
    coveredTo: null,
    groupId: null,
    error: null,
    createdAt: SERVER_TIME,
    startedAt: null,
    finishedAt: null,
    ...patch,
  });

const FOREIGN = run({
  id: FOREIGN_ID,
  status: 'running',
  requestedBy: CI,
  groupId: `fs-replay-${FOREIGN_ID}`,
  progress: { offsetsTotal: 4_000, offsetsDone: 1_000, framesMatched: 900, framesRejected: 0 },
  startedAt: SERVER_TIME,
});

interface Stand {
  runs: ReplayRun[];
  active: ReplayRun | null;
  launchStatus: number;
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

/** Ответы шлюза по адресам: запрос перепрогона проверяется схемой контракта. */
const route = (path: string, init?: RequestInit): Promise<Response> => {
  const method = init?.method ?? 'GET';
  const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  calls.push({ method, path, body });
  const url = new URL(path, 'http://stand');

  if (url.pathname === '/api/topology') return reply(200, TOPOLOGY);

  const rules = /^\/api\/devices\/([A-Z]{2}-\d{3})\/alarm-rules$/.exec(url.pathname);
  if (rules !== null) {
    const code = rules[1]!;
    return reply(
      200,
      alarmRulesResponseSchema.parse({
        deviceCode: code,
        rules: code.startsWith('RC') ? CHAMBER_RULES : METER_RULES,
      }),
    );
  }

  const profile = /^\/api\/devices\/([A-Z]{2}-\d{3})\/profile$/.exec(url.pathname);
  if (profile !== null) return reply(200, profileOf(profile[1]!));

  if (url.pathname === '/api/replay-runs' && method === 'GET') {
    return reply(
      200,
      replayRunsResponseSchema.parse({
        serverTime: SERVER_TIME,
        retentionMs: RETENTION_MS,
        runs: stand.runs,
        activeRun: stand.active,
      }),
    );
  }

  if (url.pathname === '/api/replay-runs' && method === 'POST') {
    const request = replayRequestSchema.parse(body);
    if (stand.launchStatus === 409) {
      stand.active = FOREIGN;
      stand.runs = [FOREIGN, ...stand.runs];
      return reply(409, { statusCode: 409, message: BUSY_MESSAGE, error: 'Conflict' });
    }
    const accepted = run({
      from: request.from,
      to: request.to,
      deviceCodes: request.deviceCodes,
      patches: request.patches,
    });
    stand.active = accepted;
    stand.runs = [accepted, ...stand.runs];
    return reply(202, accepted);
  }

  const single = /^\/api\/replay-runs\/([0-9a-f-]+)$/.exec(url.pathname);
  if (single !== null) {
    const found = stand.runs.find((item) => item.id === single[1]);
    return found === undefined ? reply(404, { message: 'прогона нет' }) : reply(200, found);
  }

  return reply(404, { message: 'нет такого адреса' });
};

const launches = (): Call[] =>
  calls.filter((call) => call.method === 'POST' && call.path === '/api/replay-runs');

const readsOf = (path: string): number =>
  calls.filter((call) => call.method === 'GET' && call.path === path).length;

let client: QueryClient;

const signIn = (permissions: readonly ModuleId[]): void => {
  useSessionStore.setState({
    accessToken: 'токен',
    expiresAt: '2026-02-11T11:00:00.000Z',
    user: {
      id: 'ba0ba102-a143-4f6c-8538-47bded9939fb',
      email: ENGINEER,
      displayName: 'Инженер',
      role: permissions.includes('replay.run') ? 'engineer' : 'viewer',
      permissions: [...permissions],
    },
    checked: true,
  });
};

const show = (): void => {
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/replay']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  render(<ReplayPage />, { wrapper });
};

/** Форма нового перепрогона. */
const form = async () => within(await screen.findByRole('region', { name: 'Новый перепрогон' }));

/** Кнопка прибора в выборе приборов. */
const deviceButton = (code: string): HTMLElement =>
  within(screen.getByRole('region', { name: 'Новый перепрогон' })).getByRole('button', {
    name: new RegExp(`^${code}\\b`),
  });

/** Кнопка примера, когда топология пришла и пример есть на что положить. */
const exampleButton = async (): Promise<HTMLElement> => {
  const button = await within(
    await screen.findByRole('region', { name: 'Новый перепрогон' }),
  ).findByRole('button', { name: 'Граница испарителя в оттайке +8' });
  await waitFor(() => {
    expect(button).toBeEnabled();
  });

  return button;
};

beforeEach(() => {
  calls = [];
  stand = { runs: [], active: null, launchStatus: 202 };
  Object.defineProperty(globalThis, 'fetch', { writable: true, value: vi.fn(route) });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  signIn(['overview', 'devices', 'alarms', 'replay', 'replay.run']);
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  resetServerClock();
});

describe('форма перепрогона', () => {
  it('пример правки выбирает камеры, подсказывает текущую уставку и уходит одним запросом', async () => {
    const user = userEvent.setup();
    show();

    const scope = await form();
    expect(await scope.findByRole('button', { name: /^RC-101\b/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(
      scope.getByRole('button', { name: 'Граница испарителя в оттайке +8' }),
    ).toHaveAccessibleDescription(/Змеевик испарителя в оттайке штатно греется до \+10 °C/);

    await user.click(scope.getByRole('button', { name: 'Граница испарителя в оттайке +8' }));

    expect(deviceButton('RC-101')).toHaveAttribute('aria-pressed', 'true');
    expect(deviceButton('RC-102')).toHaveAttribute('aria-pressed', 'true');
    expect(deviceButton('PM-201')).toHaveAttribute('aria-pressed', 'false');
    expect(scope.getByText('выбрано 2 из 3')).toBeInTheDocument();

    const patch = within(scope.getByRole('group', { name: 'Правка 1' }));
    expect(patch.getByLabelText('Верхняя граница')).toHaveValue(8);
    expect(await patch.findByText('сейчас 12')).toBeInTheDocument();
    expect(patch.getByText('сейчас -28')).toBeInTheDocument();
    expect(patch.getByText('сейчас 6')).toBeInTheDocument();
    expect(patch.getByText('сейчас включена')).toBeInTheDocument();
    await waitFor(() => {
      expect(patch.getByRole('combobox', { name: /Параметр/ })).toHaveTextContent(
        'Температура испарителя',
      );
    });
    expect(patch.getByRole('combobox', { name: /Режим/ })).toHaveTextContent('оттайка');

    await user.click(scope.getByRole('button', { name: '15 мин' }));
    await user.click(scope.getByRole('button', { name: 'Поставить перепрогон' }));

    await waitFor(() => {
      expect(launches()).toHaveLength(1);
    });
    const request = replayRequestSchema.parse(launches()[0]?.body);
    expect(request.deviceCodes).toEqual(['RC-101', 'RC-102']);
    expect(request.patches).toEqual([{ metricKey: 'evap_temp_c', mode: 'defrost', maxValue: 8 }]);
    expect(Date.parse(request.to) - Date.parse(request.from)).toBe(900_000);

    const panel = within(await screen.findByRole('region', { name: 'Ход перепрогона' }));
    expect(panel.getByText('в очереди')).toBeInTheDocument();
    expect(
      await panel.findByText('Температура испарителя, оттайка: верхняя граница 8'),
    ).toBeInTheDocument();
    expect(scope.queryByRole('alert')).toBeNull();
  });

  it('снятие границы уходит как null, а пустое поле не уходит вовсе', async () => {
    const user = userEvent.setup();
    show();

    const scope = await form();
    await user.click(await exampleButton());
    const patch = within(scope.getByRole('group', { name: 'Правка 1' }));
    await patch.findByText('сейчас 12');

    const clear = patch.getByRole('button', { name: 'Снять нижнюю границу' });
    expect(clear).toHaveAttribute('aria-pressed', 'false');
    await user.click(clear);
    expect(clear).toHaveAttribute('aria-pressed', 'true');
    expect(patch.getByLabelText('Нижняя граница')).toBeDisabled();
    expect(patch.getByText('граница будет снята')).toBeInTheDocument();

    await user.click(scope.getByRole('button', { name: 'Поставить перепрогон' }));

    await waitFor(() => {
      expect(launches()).toHaveLength(1);
    });
    expect(replayRequestSchema.parse(launches()[0]?.body).patches).toEqual([
      { metricKey: 'evap_temp_c', mode: 'defrost', minValue: null, maxValue: 8 },
    ]);
  });

  it('проблемы формы объяснены словами, и запрос не уходит', async () => {
    const user = userEvent.setup();
    show();

    const scope = await form();
    await scope.findByRole('button', { name: /^RC-101\b/ });
    await user.click(scope.getByRole('button', { name: 'Поставить перепрогон' }));

    const alert = await scope.findByRole('alert');
    expect(alert).toHaveTextContent('Выберите хотя бы один прибор.');
    expect(alert).toHaveTextContent('Правка 1: выберите параметр.');

    await user.click(scope.getByRole('button', { name: 'Граница испарителя в оттайке +8' }));
    const patch = within(scope.getByRole('group', { name: 'Правка 1' }));
    await patch.findByText('сейчас 12');

    const min = patch.getByLabelText('Нижняя граница');
    await user.type(min, '10');
    expect(await scope.findByRole('alert')).toHaveTextContent(
      'Правка «Температура испарителя, оттайка»: нижняя граница должна быть меньше верхней.',
    );

    await user.clear(patch.getByLabelText('Верхняя граница'));
    await user.clear(min);
    await user.type(min, '15');
    expect(await scope.findByRole('alert')).toHaveTextContent(
      'у прибора RC-101 нижняя граница 15 окажется не ниже верхней 12.',
    );

    await user.clear(min);
    await user.click(scope.getByRole('button', { name: 'Поставить перепрогон' }));
    expect(await scope.findByRole('alert')).toHaveTextContent(
      'Правка «Температура испарителя, оттайка»: измените хотя бы одно поле.',
    );

    expect(launches()).toEqual([]);
  });

  it('пример правки ждёт приборы стенда и до них выбор не сбрасывает', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const plain = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', {
      writable: true,
      value: vi.fn(async (path: string, init?: RequestInit) => {
        if (path === '/api/topology') await held;
        return plain(path, init);
      }),
    });
    show();

    const scope = await form();
    expect(scope.getByRole('button', { name: 'Граница испарителя в оттайке +8' })).toBeDisabled();

    release();
    expect(await exampleButton()).toBeEnabled();
  });

  it('без права ставить перепрогон форма только для чтения и это объяснено', async () => {
    signIn(['overview', 'devices', 'alarms', 'replay']);
    show();

    const scope = await form();
    expect(scope.getByRole('note')).toHaveTextContent('Ставить перепрогон может инженер');
    expect(await scope.findByRole('button', { name: /^RC-101\b/ })).toBeDisabled();
    expect(scope.getByRole('button', { name: 'Все холодильные камеры' })).toBeDisabled();
    expect(scope.getByRole('button', { name: 'Граница испарителя в оттайке +8' })).toBeDisabled();
    expect(scope.getByRole('button', { name: '15 мин' })).toBeDisabled();
    expect(scope.getByRole('button', { name: 'Поставить перепрогон' })).toBeDisabled();
    expect(launches()).toEqual([]);
  });

  it('занятый стенд: перечитан список, идущий прогон показан, а постановка ждёт его итога', async () => {
    const user = userEvent.setup();
    stand.launchStatus = 409;
    show();

    const scope = await form();
    await user.click(await exampleButton());
    const listReads = readsOf('/api/replay-runs');
    await user.click(scope.getByRole('button', { name: 'Поставить перепрогон' }));

    expect(await scope.findByRole('alert')).toHaveTextContent(
      `Стенд занят: ${BUSY_MESSAGE}. Идущий прогон показан ниже.`,
    );
    await waitFor(() => {
      expect(readsOf('/api/replay-runs')).toBeGreaterThan(listReads);
    });

    const panel = within(await screen.findByRole('region', { name: 'Ход перепрогона' }));
    expect(await panel.findByText(/^поставил ci@fieldstream\.local/)).toBeInTheDocument();
    expect(panel.getByText(`fs-replay-${FOREIGN_ID}`)).toBeInTheDocument();

    const submit = scope.getByRole('button', { name: 'Поставить перепрогон' });
    await waitFor(() => {
      expect(submit).toHaveAttribute('aria-disabled', 'true');
    });
    expect(submit).toHaveAccessibleDescription(
      `Сейчас идёт перепрогон, который поставил ${CI}: новый можно поставить после его итога.`,
    );

    await user.click(submit);
    expect(launches()).toHaveLength(1);
  });
});

describe('проверка формы до отправки', () => {
  const catalog = (rules: readonly AlarmRuleView[]): RuleCatalog => ({
    byDevice: new Map([
      ['RC-101', rules],
      ['RC-102', rules],
    ]),
    loaded: true,
    failed: false,
  });

  const context = (rules: readonly AlarmRuleView[]): FormContext => ({
    nowMs: Date.parse(SERVER_TIME),
    retentionMs: RETENTION_MS,
    rules: catalog(rules),
    labelOf: () => 'Температура испарителя',
  });

  const draft = (id: number, edit: Partial<PatchDraft>): PatchDraft => ({
    id,
    metricKey: 'evap_temp_c',
    mode: 'defrost',
    minValue: '',
    maxValue: '',
    clearMin: false,
    clearMax: false,
    hysteresis: '',
    debounceCycles: '',
    enabled: 'keep',
    ...edit,
  });

  it('правка выключенной уставки без включения отвергается так же, как у шлюза', () => {
    const state = {
      ...INITIAL_FORM,
      devices: ['RC-101', 'RC-102'],
      patches: [draft(1, { maxValue: '8' })],
    };

    expect(evaluateForm(state, context([rule({ enabled: false })])).problems).toEqual([
      'Правка «Температура испарителя, оттайка»: уставка выключена у всех выбранных приборов и на срабатывания не влияет, включите её в правке.',
    ]);

    const enabling = { ...state, patches: [draft(1, { maxValue: '8', enabled: 'on' })] };
    expect(evaluateForm(enabling, context([rule({ enabled: false })])).request).not.toBeNull();
  });

  it('одинаковые проблемы не повторяются', () => {
    const state = {
      ...INITIAL_FORM,
      devices: ['RC-101'],
      patches: [draft(1, { maxValue: '8' }), draft(2, { maxValue: '7' }), draft(3, {})],
    };

    expect(evaluateForm(state, context(CHAMBER_RULES)).problems).toEqual([
      'Правка «Температура испарителя, оттайка»: эта уставка уже правится выше.',
    ]);
  });
});
