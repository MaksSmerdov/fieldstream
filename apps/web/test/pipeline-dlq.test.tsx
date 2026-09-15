import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOPICS,
  dlqListResponseSchema,
  dlqMessageSchema,
  dlqRedriveRequestSchema,
  dlqRedriveSchema,
  pipelineResponseSchema,
} from '@fieldstream/contracts';
import type {
  DlqListResponse,
  DlqMessage,
  DlqRedrive,
  ModuleId,
  PipelineResponse,
} from '@fieldstream/contracts';
import {
  REDRIVE_POLL_MS,
  REDRIVE_WAIT_LIMIT_MS,
} from '../src/features/pipeline/hooks/dlq/useDlqRedrive.js';
import { PipelinePage } from '../src/pages/PipelinePage.js';
import { queryKeys } from '../src/shared/api/query-keys.js';
import { useSessionStore } from '../src/shared/auth/session-store.js';
import { resetServerClock } from '../src/shared/time/serverClock.js';

const SERVER_TIME = '2026-02-11T10:00:00.000Z';
const RAW = TOPICS.telemetryRaw.name;

const at = (offsetMs: number): string => new Date(Date.parse(SERVER_TIME) + offsetMs).toISOString();

const SNAPSHOT: PipelineResponse = pipelineResponseSchema.parse({
  serverTime: SERVER_TIME,
  sampledAt: at(-2_000),
  brokerError: null,
  topics: [
    {
      name: RAW,
      owner: 'edge-collector',
      cleanupPolicy: 'delete',
      partitions: [{ partition: 0, low: 0, high: 10 }],
      messagesPerSec: 1,
    },
  ],
  groups: [],
  rebalances: [],
  dlq: { unresolved: 2, total: 3 },
  live: { streams: 0, eventsPerSec: 0 },
});

/** Сообщение очереди, прошедшее схему контракта. */
const message = (id: number, patch: Partial<DlqMessage> = {}): DlqMessage =>
  dlqMessageSchema.parse({
    id: String(id),
    sourceTopic: RAW,
    partition: 2,
    offset: String(1_000 + id),
    key: 'RC-102',
    errorClass: 'SchemaError',
    error: 'поле ts отсутствует',
    attempts: 1,
    firstSeen: at(-600_000),
    lastSeen: at(-60_000),
    resolvedAt: null,
    finalRejected: false,
    payloadPreview: '{"schema":"telemetry.raw","v":1',
    payloadBytes: 212,
    ...patch,
  });

const page = (items: readonly DlqMessage[], nextCursor: string | null): DlqListResponse =>
  dlqListResponseSchema.parse({ serverTime: SERVER_TIME, items, nextCursor });

/** Запрос повторной подачи, прошедший схему контракта. */
const redrive = (patch: Partial<DlqRedrive> = {}): DlqRedrive =>
  dlqRedriveSchema.parse({
    id: '7',
    status: 'queued',
    maxMessages: 50,
    redriven: 0,
    rejected: 0,
    error: null,
    requestedBy: 'engineer@fieldstream.local',
    createdAt: SERVER_TIME,
    startedAt: null,
    finishedAt: null,
    ...patch,
  });

interface Stand {
  snapshot: PipelineResponse;
  pages: Readonly<Record<string, DlqListResponse>>;
  listStatus: number;
  holds: Partial<Record<string, Promise<void>>>;
  redriveStatus: number;
  /** Шаги хода: запрос, код ошибки опроса или ответ не по контракту; последний шаг повторяется. */
  progress: (DlqRedrive | number | 'broken')[];
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

/** Ответы шлюза по адресам: ход запроса отдаётся по одному шагу на каждый опрос. */
const route = (path: string, init?: RequestInit): Promise<Response> => {
  const method = init?.method ?? 'GET';
  const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  calls.push({ method, path, body });
  const url = new URL(path, 'http://stand');

  if (url.pathname === '/api/pipeline') return reply(200, stand.snapshot);

  if (url.pathname === '/api/dlq') {
    const cursor = url.searchParams.get('cursor') ?? '';
    const found = stand.pages[cursor];
    return (stand.holds[cursor] ?? Promise.resolve()).then(() =>
      stand.listStatus === 200 && found !== undefined
        ? reply(200, found)
        : reply(stand.listStatus === 200 ? 404 : stand.listStatus, {
            message: 'список не прочитан',
          }),
    );
  }

  if (url.pathname === '/api/dlq/redrive' && method === 'POST') {
    const request = dlqRedriveRequestSchema.parse(body);
    return stand.redriveStatus === 202
      ? reply(202, redrive({ maxMessages: request.max }))
      : reply(stand.redriveStatus, { message: 'нет права pipeline.control' });
  }

  if (url.pathname === '/api/dlq/redrive/7') {
    const next = stand.progress.length > 1 ? stand.progress.shift() : stand.progress[0];
    if (next === undefined) return reply(404, { message: 'запроса нет' });
    if (next === 'broken') return reply(200, { id: '7', status: 'потерян' });
    if (typeof next === 'number') {
      return reply(next, { message: next === 404 ? 'запроса нет' : 'шлюз перегружен' });
    }

    return reply(200, next);
  }

  return reply(404, { message: 'нет такого адреса' });
};

const callsTo = (method: string, path: string): number =>
  calls.filter((call) => call.method === method && call.path.startsWith(path)).length;

const readsOf = (path: string): number =>
  calls.filter((call) => call.method === 'GET' && call.path === path).length;

let client: QueryClient;

const signIn = (permissions: readonly ModuleId[]): void => {
  useSessionStore.setState({
    accessToken: 'токен',
    expiresAt: '2026-02-11T11:00:00.000Z',
    user: {
      id: 'ba0ba102-a143-4f6c-8538-47bded9939fb',
      email: 'engineer@fieldstream.local',
      displayName: 'Инженер',
      role: permissions.includes('pipeline.control') ? 'engineer' : 'viewer',
      permissions: [...permissions],
    },
    checked: true,
  });
};

const show = (): void => {
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/pipeline']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  render(<PipelinePage />, { wrapper });
};

const card = async () =>
  within(await screen.findByRole('region', { name: 'Очередь недоставленных' }));

type User = ReturnType<typeof userEvent.setup>;

/** Поддельные часы идут вместе с настоящими, но опрос и предел ожидания можно промотать. */
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

/** Открывает экран, дожидается списка и отправляет запрос повторной подачи. */
const startRedrive = async (user: User, max?: number) => {
  show();
  const dlq = await card();
  await dlq.findByRole('region', { name: 'Сообщения очереди недоставленных' });
  const button = dlq.getByRole('button', { name: 'Вернуть в обработку' });

  if (max !== undefined) await user.click(dlq.getByRole('button', { name: String(max) }));
  await user.click(button);
  await dlq.findByText('Запрос №7 ждёт процессор');

  return { dlq, button };
};

beforeEach(() => {
  calls = [];
  stand = {
    snapshot: SNAPSHOT,
    pages: {
      '': page(
        [
          message(9, { attempts: 2 }),
          message(8, { key: null, resolvedAt: at(-30_000), payloadPreview: '' }),
        ],
        '8',
      ),
      '8': page(
        [message(5, { attempts: 3, finalRejected: true, error: 'значение вне шкалы' })],
        null,
      ),
    },
    listStatus: 200,
    holds: {},
    redriveStatus: 202,
    progress: [],
  };
  Object.defineProperty(globalThis, 'fetch', { writable: true, value: vi.fn(route) });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  signIn(['overview', 'devices', 'alarms', 'pipeline', 'pipeline.control']);
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetServerClock();
});

describe('очередь недоставленных на экране конвейера', () => {
  it('пока список едет, показывается заглушка', async () => {
    stand.holds[''] = new Promise(() => undefined);
    show();

    const dlq = await card();

    expect(
      dlq.getByRole('status', { name: 'Загружаем очередь недоставленных' }),
    ).toBeInTheDocument();
  });

  it('список показывает сообщения, а курсор подгружает следующую страницу', async () => {
    show();

    const dlq = await card();
    const list = within(
      await dlq.findByRole('region', { name: 'Сообщения очереди недоставленных' }),
    );
    const items = (): HTMLElement[] => list.getAllByRole('listitem');

    expect(items()).toHaveLength(2);
    expect(calls.map((call) => call.path)).toContain('/api/dlq?limit=20');

    const first = within(items()[0]!);
    expect(first.getByText('ждёт')).toBeInTheDocument();
    expect(first.getByText(/^первая неудача /)).toBeInTheDocument();
    expect(first.getByText('сырые кадры, партиция 2, смещение 1009')).toBeInTheDocument();
    expect(first.getByText('ключ RC-102')).toBeInTheDocument();
    expect(first.getByText('SchemaError')).toBeInTheDocument();
    expect(first.getByText(/поле ts отсутствует/)).toBeInTheDocument();
    expect(first.getByText('2 попытки')).toBeInTheDocument();
    expect(first.getByText('{"schema":"telemetry.raw","v":1')).toBeInTheDocument();
    expect(first.getByText('212 байт')).toBeInTheDocument();

    const second = within(items()[1]!);
    expect(second.getByText('возвращено')).toBeInTheDocument();
    expect(second.getByText('без ключа')).toBeInTheDocument();
    expect(second.getByText('тело пустое')).toBeInTheDocument();

    expect(dlq.getByText('показано 2 сообщения')).toBeInTheDocument();
    await userEvent.click(dlq.getByRole('button', { name: 'Показать ещё' }));

    await waitFor(() => {
      expect(items()).toHaveLength(3);
    });
    expect(calls.map((call) => call.path)).toContain('/api/dlq?limit=20&cursor=8');

    const third = within(items()[2]!);
    expect(third.getByText('окончательно отвергнуто')).toBeInTheDocument();
    expect(third.getByText('3 попытки')).toBeInTheDocument();
    expect(dlq.getByText('показано 3 сообщения')).toBeInTheDocument();
    expect(dlq.queryByRole('button', { name: 'Показать ещё' })).not.toBeInTheDocument();
  });

  it('строку с длинным текстом можно раскрыть с клавиатуры, короткую раскрывать незачем', async () => {
    show();

    const dlq = await card();
    const list = within(
      await dlq.findByRole('region', { name: 'Сообщения очереди недоставленных' }),
    );
    const [first, second] = list.getAllByRole('listitem');

    const toggle = within(first!).getByRole('button', { name: 'подробнее, смещение 1009' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const details = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(details).toHaveTextContent('SchemaError поле ts отсутствует');
    expect(details).toHaveTextContent('{"schema":"telemetry.raw","v":1');

    toggle.focus();
    await userEvent.keyboard('{Enter}');

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAccessibleName('свернуть, смещение 1009');
    expect(toggle).toHaveFocus();

    await userEvent.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    expect(within(second!).queryByRole('button', { name: /подробнее/ })).toBeNull();
  });

  it('перечитывание по новым счётам не сбивает подгрузку следующей страницы', async () => {
    let release = (): void => undefined;
    stand.holds['8'] = new Promise<void>((resolve) => {
      release = resolve;
    });
    show();

    const dlq = await card();
    const list = within(
      await dlq.findByRole('region', { name: 'Сообщения очереди недоставленных' }),
    );
    await userEvent.click(dlq.getByRole('button', { name: 'Показать ещё' }));
    expect(await dlq.findByRole('button', { name: 'Загружаем' })).toBeDisabled();

    const firstPageReads = readsOf('/api/dlq?limit=20');
    stand.snapshot = { ...SNAPSHOT, dlq: { unresolved: 3, total: 4 } };
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.pipeline });
    });
    await waitFor(() => {
      expect(dlq.getAllByRole('definition').map((item) => item.textContent)).toEqual(['3', '4']);
    });
    expect(readsOf('/api/dlq?limit=20')).toBe(firstPageReads);

    release();

    await waitFor(() => {
      expect(list.getAllByRole('listitem')).toHaveLength(3);
    });
    await waitFor(() => {
      expect(readsOf('/api/dlq?limit=20&cursor=8')).toBe(2);
    });
    expect(readsOf('/api/dlq?limit=20')).toBe(firstPageReads + 1);
    await waitFor(() => {
      expect(dlq.getByText('показано 3 сообщения')).toBeInTheDocument();
    });
  });

  it('пустая очередь названа хорошей новостью, а вернуть нечего', async () => {
    stand.snapshot = { ...SNAPSHOT, dlq: { unresolved: 0, total: 0 } };
    stand.pages = { '': page([], null) };
    show();

    const dlq = await card();

    expect(await dlq.findByText('Очередь пуста')).toBeInTheDocument();
    expect(dlq.getByText(/Это хорошая новость/)).toBeInTheDocument();
    expect(dlq.queryByRole('region', { name: 'Сообщения очереди недоставленных' })).toBeNull();

    const button = dlq.getByRole('button', { name: 'Вернуть в обработку' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(dlq.getByText('Возвращать нечего: неразобранных сообщений нет.')).toBeInTheDocument();

    await userEvent.click(button);
    expect(callsTo('POST', '/api/dlq/redrive')).toBe(0);
  });

  it('ошибка списка объяснена, а повтор возвращает сообщения', async () => {
    stand.listStatus = 503;
    show();

    const dlq = await card();

    expect(await dlq.findByRole('alert')).toHaveTextContent('Сервер недоступен');

    stand.listStatus = 200;
    await userEvent.click(dlq.getByRole('button', { name: 'Повторить' }));

    expect(
      await dlq.findByRole('region', { name: 'Сообщения очереди недоставленных' }),
    ).toBeInTheDocument();
    expect(dlq.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('без права управлять конвейером кнопка недоступна и это объяснено', async () => {
    signIn(['overview', 'devices', 'alarms', 'pipeline']);
    show();

    const dlq = await card();

    expect(dlq.getByRole('note')).toHaveTextContent(
      'Возвращать сообщения в обработку может инженер',
    );
    expect(dlq.getByRole('button', { name: 'Вернуть в обработку' })).toBeDisabled();
    expect(dlq.getByRole('button', { name: '200' })).toBeDisabled();
    expect(
      await dlq.findByRole('region', { name: 'Сообщения очереди недоставленных' }),
    ).toBeInTheDocument();
  });

  it('ход виден до итога, фокус остаётся на кнопке, опрос стоит, а список и снимок перечитаны', async () => {
    const user = fakeClock();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    stand.progress = [
      redrive({ status: 'running', maxMessages: 200, startedAt: SERVER_TIME }),
      redrive({
        status: 'done',
        maxMessages: 200,
        redriven: 2,
        rejected: 1,
        startedAt: SERVER_TIME,
        finishedAt: at(1_000),
      }),
    ];

    const { dlq, button } = await startRedrive(user, 200);

    expect(calls).toContainEqual({ method: 'POST', path: '/api/dlq/redrive', body: { max: 200 } });
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-disabled', 'true');

    await user.click(button);
    expect(callsTo('POST', '/api/dlq/redrive')).toBe(1);

    await pass(REDRIVE_POLL_MS);
    expect(
      await dlq.findByText('Процессор возвращает в обработку до 200 сообщений'),
    ).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: queryKeys.pipeline });

    const listReads = readsOf('/api/dlq?limit=20');
    stand.snapshot = { ...SNAPSHOT, dlq: { unresolved: 1, total: 4 } };

    await pass(REDRIVE_POLL_MS);
    expect(
      await dlq.findByText('Готово: возвращено 2, окончательно отвергнуто 1'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(button).not.toHaveAttribute('aria-disabled');
    });
    expect(button).toHaveFocus();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.pipeline });
    await waitFor(() => {
      expect(dlq.getAllByRole('definition').map((item) => item.textContent)).toEqual(['1', '4']);
    });
    await waitFor(() => {
      expect(readsOf('/api/dlq?limit=20')).toBe(listReads + 1);
    });
    expect(callsTo('GET', '/api/dlq/redrive/7')).toBe(2);

    await pass(REDRIVE_POLL_MS * 3);
    expect(callsTo('GET', '/api/dlq/redrive/7')).toBe(2);
    expect(readsOf('/api/dlq?limit=20')).toBe(listReads + 1);
  });

  it('подгрузка следующей страницы, идущая в момент итога повторной подачи, не теряется', async () => {
    const user = fakeClock();
    let release = (): void => undefined;
    stand.holds['8'] = new Promise<void>((resolve) => {
      release = resolve;
    });
    stand.progress = [redrive({ status: 'done', redriven: 1, finishedAt: at(1_000) })];

    const { dlq } = await startRedrive(user);
    const list = within(dlq.getByRole('region', { name: 'Сообщения очереди недоставленных' }));
    await user.click(dlq.getByRole('button', { name: 'Показать ещё' }));
    expect(await dlq.findByRole('button', { name: 'Загружаем' })).toBeDisabled();

    const firstPageReads = readsOf('/api/dlq?limit=20');
    stand.snapshot = { ...SNAPSHOT, dlq: { unresolved: 1, total: 3 } };

    await pass(REDRIVE_POLL_MS);
    expect(
      await dlq.findByText('Готово: возвращено 1, окончательно отвергнуто 0'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(dlq.getAllByRole('definition').map((item) => item.textContent)).toEqual(['1', '3']);
    });
    expect(dlq.getByRole('button', { name: 'Загружаем' })).toBeDisabled();
    expect(readsOf('/api/dlq?limit=20')).toBe(firstPageReads);

    release();

    await waitFor(() => {
      expect(list.getAllByRole('listitem')).toHaveLength(3);
    });
    await waitFor(() => {
      expect(readsOf('/api/dlq?limit=20&cursor=8')).toBe(2);
    });
    expect(readsOf('/api/dlq?limit=20')).toBe(firstPageReads + 1);
  });

  it('«Показать ещё» поверх перечитывания по новым счётам: перечитывание повторяется после подгрузки', async () => {
    show();

    const dlq = await card();
    const list = within(
      await dlq.findByRole('region', { name: 'Сообщения очереди недоставленных' }),
    );
    const firstPageReads = readsOf('/api/dlq?limit=20');

    stand.holds[''] = new Promise(() => undefined);
    stand.snapshot = { ...SNAPSHOT, dlq: { unresolved: 3, total: 4 } };
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.pipeline });
    });
    await waitFor(() => {
      expect(readsOf('/api/dlq?limit=20')).toBe(firstPageReads + 1);
    });

    stand.holds = {};
    await userEvent.click(dlq.getByRole('button', { name: 'Показать ещё' }));

    await waitFor(() => {
      expect(list.getAllByRole('listitem')).toHaveLength(3);
    });
    await waitFor(() => {
      expect(readsOf('/api/dlq?limit=20')).toBe(firstPageReads + 2);
    });
    await waitFor(() => {
      expect(readsOf('/api/dlq?limit=20&cursor=8')).toBe(2);
    });
    expect(dlq.getByText('показано 3 сообщения')).toBeInTheDocument();
  });

  it('временный сбой опроса не останавливает ход', async () => {
    const user = fakeClock();
    stand.progress = [503, redrive({ status: 'done', redriven: 1 })];

    const { dlq, button } = await startRedrive(user);

    await pass(REDRIVE_POLL_MS);
    expect(
      await dlq.findByText(
        'Не удалось узнать ход запроса: шлюз перегружен. Спросим снова через секунду.',
      ),
    ).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-disabled', 'true');

    await pass(REDRIVE_POLL_MS);
    expect(
      await dlq.findByText('Готово: возвращено 1, окончательно отвергнуто 0'),
    ).toBeInTheDocument();
    expect(callsTo('GET', '/api/dlq/redrive/7')).toBe(2);
  });

  it('неустранимая ошибка опроса останавливает ход и освобождает кнопку', async () => {
    const user = fakeClock();
    stand.progress = [404];

    const { dlq, button } = await startRedrive(user);

    await pass(REDRIVE_POLL_MS);
    expect(await dlq.findByRole('alert')).toHaveTextContent(
      'Ход запроса №7 больше не узнать: запроса нет. Итог видно по счётам очереди',
    );
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(button).toHaveFocus();
    expect(dlq.queryByText(/Спросим снова/)).toBeNull();
    expect(callsTo('GET', '/api/dlq/redrive/7')).toBe(1);

    await pass(REDRIVE_POLL_MS * 3);
    expect(callsTo('GET', '/api/dlq/redrive/7')).toBe(1);
  });

  it('ответ опроса не по контракту останавливает ход без технических подробностей', async () => {
    const user = fakeClock();
    stand.progress = ['broken'];

    const { dlq, button } = await startRedrive(user);

    await pass(REDRIVE_POLL_MS);
    const alert = await dlq.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Ход запроса №7 больше не узнать: ответ шлюза не по контракту. Итог видно по счётам очереди',
    );
    expect(alert.textContent).not.toMatch(/[[{]/);
    expect(button).not.toHaveAttribute('aria-disabled');

    await pass(REDRIVE_POLL_MS * 3);
    expect(callsTo('GET', '/api/dlq/redrive/7')).toBe(1);
  });

  it('запрос, застрявший у процессора, перестают ждать после предела и разрешают новый', async () => {
    const user = fakeClock();
    stand.progress = [redrive({ status: 'running', startedAt: SERVER_TIME })];

    const { dlq, button } = await startRedrive(user);

    await pass(REDRIVE_POLL_MS);
    expect(
      await dlq.findByText('Процессор возвращает в обработку до 50 сообщений'),
    ).toBeInTheDocument();
    await pass(0);
    expect(button).toHaveAttribute('aria-disabled', 'true');

    await pass(REDRIVE_WAIT_LIMIT_MS);
    expect(await dlq.findByRole('alert')).toHaveTextContent(
      `Процессор не закончил запрос №7 за ${String(REDRIVE_WAIT_LIMIT_MS / 1_000)} с`,
    );
    expect(button).not.toHaveAttribute('aria-disabled');

    const polls = callsTo('GET', '/api/dlq/redrive/7');
    await pass(REDRIVE_POLL_MS * 3);
    expect(callsTo('GET', '/api/dlq/redrive/7')).toBe(polls);

    await user.click(button);
    expect(await dlq.findByText('Запрос №7 ждёт процессор')).toBeInTheDocument();
    expect(callsTo('POST', '/api/dlq/redrive')).toBe(2);
    expect(button).toHaveAttribute('aria-disabled', 'true');
  });

  it('отказ шлюза принять запрос виден рядом с кнопкой', async () => {
    stand.redriveStatus = 403;
    show();

    const dlq = await card();
    await dlq.findByRole('region', { name: 'Сообщения очереди недоставленных' });
    const button = dlq.getByRole('button', { name: 'Вернуть в обработку' });
    await userEvent.click(button);

    expect(await dlq.findByRole('alert')).toHaveTextContent(
      'Не удалось запросить повторную подачу: нет права pipeline.control',
    );
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(button).toHaveFocus();
    expect(callsTo('GET', '/api/dlq/redrive/')).toBe(0);
  });

  it('неудачный запрос заканчивается текстом ошибки процессора', async () => {
    const user = fakeClock();
    stand.progress = [redrive({ status: 'failed', error: 'брокер не принял сообщение' })];

    const { dlq, button } = await startRedrive(user);

    await pass(REDRIVE_POLL_MS);
    expect(await dlq.findByRole('alert')).toHaveTextContent(
      'Запрос не выполнен: брокер не принял сообщение',
    );
    await waitFor(() => {
      expect(button).not.toHaveAttribute('aria-disabled');
    });
    expect(button).toHaveFocus();
  });
});
