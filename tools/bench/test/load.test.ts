import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyLoad, readPolls } from '../src/load.js';
import type { Gateway, GatewayReply, HttpMethod, LinePoll } from '../src/measure.js';

const AT = '2026-09-21T17:14:10.365Z';

/** Запрос, дошедший до поддельного шлюза. */
interface Sent {
  readonly method: HttpMethod;
  readonly path: string;
  readonly body?: unknown;
}

/** Снимок линии в ответе /api/lab/lines: замеру нужны только код линии и такт. */
const liveLine = (line: LinePoll): unknown => ({
  schema: 'line.status',
  v: 1,
  ts: AT,
  lineCode: line.lineCode,
  running: true,
  connected: true,
  planMode: 'merged',
  pollIntervalMs: line.pollIntervalMs,
  requestTimeoutMs: 1_000,
  hardTimeoutMs: 2_000,
  watchdog: { limitMs: 300_000, cycleStartedAt: null, trips: 0 },
  lastCycle: null,
  reconnects: [],
  devices: [],
  latency: {
    bucketsMs: [100],
    counts: [0, 0],
    samples: 0,
    timeouts: 0,
    p50Ms: null,
    p95Ms: null,
    p99Ms: null,
    suggestedTimeoutMs: null,
  },
});

/** Линия топологии в ответе /api/topology. */
const topologyLine = (line: LinePoll): unknown => ({
  code: line.lineCode,
  baud: 9_600,
  pollIntervalMs: line.pollIntervalMs,
  requestTimeoutMs: 1_000,
  planMode: 'merged',
  enabled: true,
  devices: [],
});

/** Ответ шлюза на принятую команду. */
const accepted = (lineCode: string): unknown => ({
  commandId: randomUUID(),
  lineCode,
  kind: 'line.set_poll_interval',
  issuedAt: AT,
  expiresAt: AT,
});

/** Ход команды: сборщик её применил. */
const applied = (commandId: string): unknown => ({
  commandId,
  stage: 'applied',
  issuedAt: AT,
  publishedAt: AT,
  appliedAt: AT,
  attempts: 1,
  detail: 'такт опроса изменён',
});

/** Поддельный шлюз: отвечает заготовками, помнит запросы и умеет отказывать по линиям. */
const fakeGateway = (params: {
  readonly live?: readonly LinePoll[];
  readonly topology?: readonly LinePoll[];
  readonly refuse?: string[];
}): { readonly gateway: Gateway; readonly sent: Sent[]; readonly logins: () => number } => {
  const sent: Sent[] = [];
  let logins = 0;

  const request = (method: HttpMethod, path: string, body?: unknown): Promise<GatewayReply> => {
    sent.push({ method, path, body });

    if (path === '/api/lab/lines') {
      const lines = params.live ?? [];
      return Promise.resolve({
        status: 200,
        body: { serverTime: AT, lines: lines.map(liveLine) },
        error: null,
      });
    }
    if (path === '/api/topology') {
      return Promise.resolve({
        status: 200,
        body: {
          serverTime: AT,
          sites: [
            {
              code: 'SITE-A',
              name: 'Площадка',
              timezone: 'Europe/Moscow',
              gateways: [
                {
                  code: 'GW-01',
                  host: '127.0.0.1',
                  lines: (params.topology ?? []).map(topologyLine),
                },
              ],
            },
          ],
        },
        error: null,
      });
    }
    if (path === '/api/commands') {
      const lineCode =
        typeof body === 'object' && body !== null && 'lineCode' in body
          ? String(body.lineCode)
          : '';

      return Promise.resolve(
        params.refuse?.includes(lineCode) === true
          ? { status: 503, body: { message: 'сборщик не на связи' }, error: null }
          : { status: 202, body: accepted(lineCode), error: null },
      );
    }

    return Promise.resolve({
      status: 200,
      body: applied(path.slice('/api/commands/'.length)),
      error: null,
    });
  };

  const gateway: Gateway = {
    baseUrl: 'http://localhost:8080',
    email: 'engineer@fieldstream.local',
    login: () => {
      logins += 1;
      return Promise.resolve();
    },
    logout: () => Promise.resolve(true),
    request,
    offsetMs: () => 0,
    now: () => 0,
    listen: () => Promise.resolve([]),
    howListen: () => 'curl -N',
  };

  return { gateway, sent, logins: () => logins };
};

/** Команды смены такта, дошедшие до шлюза: линия и запрошенный такт. */
const commandsOf = (sent: readonly Sent[]): { line: string; ms: number }[] =>
  sent.flatMap((item) => {
    if (item.path !== '/api/commands') return [];

    const body = item.body as { lineCode: string; args: { pollIntervalMs: number } };
    return [{ line: body.lineCode, ms: body.args.pollIntervalMs }];
  });

/** Нагрузочный режим без настоящих ожиданий: стенд подделан, ждать нечего. */
const load = (params: {
  readonly gateway: Gateway;
  readonly pollIntervalMs: number;
  readonly note?: (text: string) => void;
}) =>
  applyLoad({
    gateway: params.gateway,
    pollIntervalMs: params.pollIntervalMs,
    note: params.note ?? ((): void => undefined),
    wait: () => Promise.resolve(),
  });

describe('снимок прежних тактов', () => {
  it('берётся у живого состояния сборщика, а не из таблицы линий', async () => {
    const { gateway } = fakeGateway({
      live: [{ lineCode: 'L1', pollIntervalMs: 2_000 }],
      topology: [{ lineCode: 'L1', pollIntervalMs: 10_000 }],
    });

    const snapshot = await readPolls(gateway);

    expect(snapshot.polls).toEqual([{ lineCode: 'L1', pollIntervalMs: 2_000 }]);
    expect(snapshot.source).toContain('/api/lab/lines');
  });

  it('без снимков линий откатывается на топологию и говорит об этом', async () => {
    const { gateway } = fakeGateway({ topology: [{ lineCode: 'L1', pollIntervalMs: 10_000 }] });

    const snapshot = await readPolls(gateway);

    expect(snapshot.polls).toEqual([{ lineCode: 'L1', pollIntervalMs: 10_000 }]);
    expect(snapshot.source).toContain('/api/topology');
  });
});

describe('возврат такта после нагрузочного режима', () => {
  it('возвращает линиям те такты, что стояли у сборщика до смены', async () => {
    const live = [
      { lineCode: 'L1', pollIntervalMs: 2_000 },
      { lineCode: 'L2', pollIntervalMs: 10_000 },
    ];
    const { gateway, sent } = fakeGateway({ live, topology: live });

    const handle = await load({ gateway, pollIntervalMs: 1_000 });
    const lost = await handle.restore();

    expect(lost).toEqual([]);
    expect(commandsOf(sent)).toEqual([
      { line: 'L1', ms: 1_000 },
      { line: 'L2', ms: 1_000 },
      { line: 'L1', ms: 2_000 },
      { line: 'L2', ms: 10_000 },
    ]);
  });

  it('отказ на одной линии не останавливает возврат остальных и виден вызывающему', async () => {
    const live = [
      { lineCode: 'L1', pollIntervalMs: 10_000 },
      { lineCode: 'L2', pollIntervalMs: 4_000 },
    ];
    const refuse: string[] = [];
    const { gateway, sent } = fakeGateway({ live, topology: live, refuse });

    const handle = await load({ gateway, pollIntervalMs: 1_000 });
    refuse.push('L1');
    const lost = await handle.restore();

    expect(lost).toEqual([{ lineCode: 'L1', pollIntervalMs: 10_000 }]);
    expect(commandsOf(sent)).toContainEqual({ line: 'L2', ms: 4_000 });
  });

  it('возврат идёт один раз: повторный вызов стенд не трогает', async () => {
    const live = [{ lineCode: 'L1', pollIntervalMs: 10_000 }];
    const { gateway, sent } = fakeGateway({ live, topology: live });

    const handle = await load({ gateway, pollIntervalMs: 1_000 });
    await handle.restore();
    const again = await handle.restore();

    expect(again).toEqual([]);
    expect(commandsOf(sent)).toEqual([
      { line: 'L1', ms: 1_000 },
      { line: 'L1', ms: 10_000 },
    ]);
  });

  it('при уже стоящем такте команд не отправляется вовсе', async () => {
    const live = [{ lineCode: 'L1', pollIntervalMs: 1_000 }];
    const { gateway, sent } = fakeGateway({ live, topology: live });

    const handle = await load({ gateway, pollIntervalMs: 1_000 });
    await handle.restore();

    expect(commandsOf(sent)).toEqual([]);
  });
});

describe('просроченный токен', () => {
  it('на 401 инструмент входит заново и повторяет команду', async () => {
    const live = [{ lineCode: 'L1', pollIntervalMs: 10_000 }];
    const base = fakeGateway({ live, topology: live });
    let refused = false;
    const gateway: Gateway = {
      ...base.gateway,
      request: (method, path, body) => {
        if (path === '/api/commands' && !refused) {
          refused = true;
          return Promise.resolve({
            status: 401,
            body: { message: 'токен просрочен' },
            error: null,
          });
        }

        return base.gateway.request(method, path, body);
      },
    };

    const handle = await applyLoad({
      gateway,
      pollIntervalMs: 1_000,
      note: () => undefined,
      wait: () => Promise.resolve(),
    });
    await handle.restore();

    expect(base.logins()).toBe(1);
    expect(commandsOf(base.sent)).toEqual([
      { line: 'L1', ms: 1_000 },
      { line: 'L1', ms: 10_000 },
    ]);
  });
});
