import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOPICS, pipelineResponseSchema } from '@fieldstream/contracts';
import type { PipelineGroup, PipelineResponse } from '@fieldstream/contracts';
import { PipelinePage } from '../src/pages/PipelinePage.js';
import { queryKeys } from '../src/shared/api/query-keys.js';
import { resetServerClock } from '../src/shared/time/serverClock.js';

const SERVER_TIME = '2026-02-11T10:00:00.000Z';
const SAMPLED_AT = '2026-02-11T09:59:58.000Z';
const RAW = TOPICS.telemetryRaw.name;
const CYCLES = TOPICS.pollCycles.name;
const STATUS = TOPICS.lineStatus.name;

const partitions = (count: number, low: number, high: number) =>
  Array.from({ length: count }, (_, partition) => ({ partition, low, high }));

const processorGroup = (patch: Partial<PipelineGroup> = {}): PipelineGroup => ({
  groupId: 'fs-processor',
  state: 'Stable',
  members: [
    {
      memberId: 'member-a',
      clientId: 'processor-1',
      host: '/172.18.0.5',
      assignments: [{ topic: RAW, partitions: [0, 1, 2] }],
    },
    {
      memberId: 'member-b',
      clientId: 'processor-2',
      host: '/172.18.0.6',
      assignments: [{ topic: RAW, partitions: [3, 4, 5] }],
    },
  ],
  lag: [
    { topic: RAW, partition: 0, committed: 300, high: 340, lag: 40, memberId: 'member-a' },
    { topic: RAW, partition: 1, committed: null, high: 340, lag: null, memberId: 'member-a' },
    { topic: RAW, partition: 2, committed: 340, high: 340, lag: 0, memberId: 'member-a' },
    { topic: RAW, partition: 3, committed: 340, high: 340, lag: 0, memberId: 'member-b' },
    { topic: RAW, partition: 4, committed: 340, high: 340, lag: 0, memberId: 'member-b' },
    { topic: RAW, partition: 5, committed: 340, high: 340, lag: 0, memberId: 'member-b' },
  ],
  totalLag: 40,
  lagSeconds: 8,
  ...patch,
});

/** Снимок конвейера, прошедший схему контракта. */
const snapshot = (patch: Partial<PipelineResponse> = {}): PipelineResponse =>
  pipelineResponseSchema.parse({
    serverTime: SERVER_TIME,
    sampledAt: SAMPLED_AT,
    brokerError: null,
    topics: [
      {
        name: RAW,
        owner: 'edge-collector',
        cleanupPolicy: 'delete',
        partitions: partitions(6, 100, 340),
        messagesPerSec: 12.5,
      },
      {
        name: CYCLES,
        owner: 'edge-collector',
        cleanupPolicy: 'delete',
        partitions: partitions(3, 0, 50),
        messagesPerSec: null,
      },
      {
        name: STATUS,
        owner: 'edge-collector',
        cleanupPolicy: 'compact',
        partitions: partitions(3, 0, 9),
        messagesPerSec: 1,
      },
    ],
    groups: [processorGroup()],
    rebalances: [],
    dlq: { unresolved: 3, total: 7 },
    live: { streams: 2, eventsPerSec: 5 },
    ...patch,
  });

type Reply = { readonly status: number; readonly body: PipelineResponse } | 'offline';

let reply: Reply = { status: 200, body: snapshot() };
let calls = 0;

/** Ответ шлюза на запрос снимка: экран проходит через настоящий слой запросов и разбор схем. */
const stubFetch = (): void => {
  Object.defineProperty(globalThis, 'fetch', {
    writable: true,
    value: vi.fn(() => {
      calls += 1;
      const current = reply;
      if (current === 'offline') return Promise.reject(new Error('сеть недоступна'));

      return Promise.resolve({
        ok: current.status < 400,
        status: current.status,
        headers: new Headers({ 'x-server-time': SERVER_TIME }),
        json: () => Promise.resolve(current.status < 400 ? current.body : { message: 'нет' }),
      } as unknown as Response);
    }),
  });
};

let client: QueryClient;

const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={['/pipeline']}>{children}</MemoryRouter>
  </QueryClientProvider>
);

const show = (): void => {
  render(<PipelinePage />, { wrapper });
};

beforeEach(() => {
  calls = 0;
  reply = { status: 200, body: snapshot() };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  stubFetch();
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  resetServerClock();
});

describe('экран конвейера', () => {
  it('пока снимок едет, показывается заглушка', () => {
    show();

    expect(screen.getByRole('status', { name: 'Загружаем конвейер' })).toBeInTheDocument();
  });

  it('недоступный шлюз объясняется словами, а повтор возвращает экран', async () => {
    reply = { status: 503, body: snapshot() };
    show();

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер недоступен');

    reply = { status: 200, body: snapshot() };
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByRole('region', { name: 'Группа fs-processor' })).toBeInTheDocument();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('без групп объясняется, что стенд ещё не поднял потребителей', async () => {
    reply = { status: 200, body: snapshot({ groups: [] }) };
    show();

    expect(await screen.findByText('Потребителей пока нет')).toBeInTheDocument();
    expect(screen.getByText(/ещё не поднял потребителей/)).toBeInTheDocument();

    const before = calls;
    reply = { status: 200, body: snapshot() };
    await userEvent.click(screen.getByRole('button', { name: 'Проверить снова' }));

    expect(await screen.findByRole('region', { name: 'Группа fs-processor' })).toBeInTheDocument();
    expect(calls).toBeGreaterThan(before);
  });

  it('заголовок показывает возраст снимка брокера', async () => {
    show();

    expect(await screen.findByText('снимок брокера 2 с назад')).toBeInTheDocument();
  });

  /** Отставание читается словами у строки, а не только по штриховке полосы. */
  it('карточка группы несёт состояние, участников и строки партиций', async () => {
    show();

    const card = within(await screen.findByRole('region', { name: 'Группа fs-processor' }));

    expect(card.getByText('работает стабильно')).toBeInTheDocument();
    expect(card.getByText('суммарное отставание 40')).toBeInTheDocument();
    expect(card.getByText('примерно 8 с')).toBeInTheDocument();

    const members = within(card.getByRole('list', { name: 'Участники группы' }));
    expect(members.getByText('processor-1')).toBeInTheDocument();
    expect(members.getByText('/172.18.0.6')).toBeInTheDocument();
    expect(members.getByText('сырые кадры: 3, 4, 5')).toBeInTheDocument();

    expect(card.getByText('отставание 40')).toBeInTheDocument();
    expect(card.getByText('коммита не было')).toBeInTheDocument();
    expect(card.getAllByText('отставания нет')).toHaveLength(4);
    expect(
      card.getByRole('img', {
        name: 'Партиция 0: лог с 100 по 340, подтверждено 300, отставание 40',
      }),
    ).toBeInTheDocument();
  });

  it('во время ребаланса у строк нет участника, и это сказано словами', async () => {
    reply = {
      status: 200,
      body: snapshot({
        groups: [
          processorGroup({
            state: 'PreparingRebalance',
            members: [],
            lag: [
              { topic: RAW, partition: 0, committed: 300, high: 340, lag: 40, memberId: null },
              { topic: RAW, partition: 1, committed: 340, high: 340, lag: 0, memberId: null },
            ],
          }),
        ],
      }),
    };
    show();

    const card = within(await screen.findByRole('region', { name: 'Группа fs-processor' }));

    expect(card.getByText('готовит перераспределение')).toBeInTheDocument();
    expect(card.getAllByText('ждёт назначения')).toHaveLength(2);
    expect(card.getByText(/раскладки пока нет/)).toBeInTheDocument();
  });

  it('если брокер не отвечает, это сказано вместе с моментом показанного снимка', async () => {
    reply = {
      status: 200,
      body: snapshot({ brokerError: 'Connection timeout after 1000ms' }),
    };
    show();

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent('Брокер не отвечает');
    expect(alert).toHaveTextContent('Connection timeout after 1000ms');
    expect(alert).toHaveTextContent(/Показан снимок от/);
    expect(
      within(screen.getByRole('region', { name: 'Схема конвейера' })).getByRole('img'),
    ).toHaveAccessibleName(/брокер не отвечает/);

    const card = within(screen.getByRole('region', { name: 'Группа fs-processor' }));
    expect(card.getByText('суммарное отставание 40')).toBeInTheDocument();
    expect(card.getByText('отставание 40')).toBeInTheDocument();
  });

  /** Пустой лог не выдаётся за прочитанный: полоса и строка говорят, что сообщений нет. */
  it('пустой лог партиции сказан словами', async () => {
    const base = snapshot();
    reply = {
      status: 200,
      body: snapshot({
        topics: base.topics.map((topic) =>
          topic.name === RAW ? { ...topic, partitions: partitions(1, 340, 340) } : topic,
        ),
        groups: [
          processorGroup({
            lag: [
              { topic: RAW, partition: 0, committed: 340, high: 340, lag: 0, memberId: 'member-a' },
            ],
            totalLag: 0,
            lagSeconds: null,
          }),
        ],
      }),
    };
    show();

    const card = within(await screen.findByRole('region', { name: 'Группа fs-processor' }));

    expect(card.getByText('лог пуст, отставания нет')).toBeInTheDocument();
    expect(card.getByRole('img', { name: /^Партиция 0: лог пуст/ })).toBeInTheDocument();
  });

  it('журнал ребалансов пишет, сколько участников было и стало', async () => {
    reply = {
      status: 200,
      body: snapshot({
        rebalances: [
          { groupId: 'fs-processor', at: SAMPLED_AT, membersBefore: 1, membersAfter: 2 },
        ],
      }),
    };
    show();

    const log = within(await screen.findByRole('region', { name: 'Журнал ребалансов' }));

    expect(log.getByText('участников было 1, стало 2')).toBeInTheDocument();
    expect(log.getByText('fs-processor')).toBeInTheDocument();
  });

  it('пустой журнал ребалансов так и сказан', async () => {
    show();

    const log = within(await screen.findByRole('region', { name: 'Журнал ребалансов' }));

    expect(log.getByText(/Ребалансов пока не было/)).toBeInTheDocument();
  });

  /** Нулевой темп и неизвестный темп это разные вещи: второй показывается прочерком. */
  it('схема и таблица топиков: темп, прочерк вместо неизвестного и сообщения в логе', async () => {
    show();

    const map = within(await screen.findByRole('region', { name: 'Схема конвейера' }));
    expect(map.getByText('12,5/с')).toBeInTheDocument();
    expect(map.getByText('–')).toBeInTheDocument();
    expect(map.getByText('экземпляров 2')).toBeInTheDocument();
    expect(map.getByText('недоставленных 3')).toBeInTheDocument();
    expect(map.getByText('соединений 2')).toBeInTheDocument();

    const table = within(screen.getByRole('region', { name: 'Таблица топиков' }));
    const raw = within(table.getByRole('row', { name: /сырые кадры/ }));
    expect(raw.getByText('12,5')).toBeInTheDocument();
    expect(raw.getByText(/^1\s440$/)).toBeInTheDocument();
    expect(
      within(table.getByRole('row', { name: /циклы опроса/ })).getByText('–'),
    ).toBeInTheDocument();

    const dlq = within(screen.getByRole('region', { name: 'Очередь недоставленных' }));
    const terms = dlq.getAllByRole('term').map((item) => item.textContent);
    const values = dlq.getAllByRole('definition').map((item) => item.textContent);
    expect(Object.fromEntries(terms.map((term, index) => [term, values[index]]))).toEqual({
      неразобранных: '3',
      всего: '7',
    });
  });

  it('неудачный перезапрос оставляет снимок на экране и говорит об этом строкой', async () => {
    show();
    await screen.findByRole('region', { name: 'Группа fs-processor' });

    reply = 'offline';
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.pipeline });
    });

    await waitFor(() => {
      expect(screen.getByText(/данные на экране могли устареть/)).toBeInTheDocument();
    });
    expect(screen.getByRole('region', { name: 'Группа fs-processor' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /** История копится между опросами, и растущее отставание подсвечивает процессор. */
  it('история отставания копит снимки и замечает рост', async () => {
    show();
    await screen.findByRole('region', { name: 'Группа fs-processor' });

    const later = (index: number): string =>
      new Date(Date.parse(SERVER_TIME) + (index + 1) * 2_000).toISOString();

    for (const [index, lag] of [60, 90, 150].entries()) {
      reply = {
        status: 200,
        body: snapshot({ sampledAt: later(index), groups: [processorGroup({ totalLag: lag })] }),
      };
      await act(async () => {
        await client.refetchQueries({ queryKey: queryKeys.pipeline });
      });
      await screen.findByText(`суммарное отставание ${String(lag)}`);
    }

    const history = within(screen.getByRole('region', { name: 'История отставания' }));
    await waitFor(() => {
      expect(history.getByText('растёт')).toBeInTheDocument();
    });
    expect(history.getByRole('img')).toHaveAccessibleName(/сейчас 150, растёт/);

    const map = (): HTMLElement =>
      within(screen.getByRole('region', { name: 'Схема конвейера' })).getByRole('img');
    expect(map()).toHaveAccessibleName(/отставание процессора растёт/);

    reply = {
      status: 200,
      body: snapshot({
        sampledAt: later(2),
        brokerError: 'Connection timeout after 1000ms',
        groups: [processorGroup({ totalLag: 150 })],
      }),
    };
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.pipeline });
    });

    await waitFor(() => {
      expect(map()).toHaveAccessibleName(/брокер не отвечает/);
    });
    expect(map()).not.toHaveAccessibleName(/растёт/);
  });
});
