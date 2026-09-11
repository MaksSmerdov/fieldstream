import { describe, expect, it } from 'vitest';
import type { HealthNode, HealthPolicy } from '@fieldstream/contracts';
import type {
  BuildHealthTreeInput,
  DeviceHealthInput,
  GatewayHealthInput,
  LineHealthInput,
} from '../src/health.js';
import { buildHealthTree, latestOk } from '../src/health.js';
import { createFakeClock, toIsoTimestamp } from '../src/clock.js';

const T0 = Date.UTC(2026, 0, 1);
const POLICY: HealthPolicy = {
  offlineAfterErrors: 5,
  staleAfterMs: 300_000,
  startupGraceMs: 70_000,
};

const device = (over: Partial<DeviceHealthInput> = {}): DeviceHealthInput => ({
  code: 'RC-101',
  label: 'Камера 1',
  lastOkAtMs: null,
  consecutiveErrors: 0,
  prev: null,
  ...over,
});

const line = (
  devices: readonly DeviceHealthInput[],
  over: Partial<LineHealthInput> = {},
): LineHealthInput => ({
  code: 'L1',
  label: 'Линия 1',
  pollingEnabled: true,
  devices,
  prev: null,
  ...over,
});

const gateway = (
  lines: readonly LineHealthInput[],
  over: Partial<GatewayHealthInput> = {},
): GatewayHealthInput => ({
  code: 'GW-01',
  label: 'Шлюз 1',
  lines,
  prev: null,
  ...over,
});

const build = (
  gateways: readonly GatewayHealthInput[],
  over: Partial<BuildHealthTreeInput> = {},
): HealthNode =>
  buildHealthTree({
    site: { code: 'SITE-A', label: 'Склад A', gateways, prev: null },
    policy: POLICY,
    startedAtMs: T0,
    nowMs: T0 + 600_000,
    ...over,
  });

const nodeAt = (root: HealthNode, path: readonly number[]): HealthNode =>
  path.reduce<HealthNode>((node, index) => {
    const child = node.children[index];
    if (child === undefined) {
      throw new Error(`нет ребёнка ${String(index)} у узла ${node.code}`);
    }
    return child;
  }, root);

const firstDevice = (root: HealthNode): HealthNode => nodeAt(root, [0, 0, 0]);

describe('buildHealthTree: статус прибора', () => {
  it('startup_grace: молчащий прибор внутри окна старта не считается аварийным', () => {
    const clock = createFakeClock(T0);
    clock.advance(10_000);

    const tree = build([gateway([line([device({ consecutiveErrors: 9 })])])], {
      nowMs: clock.now(),
    });

    expect(firstDevice(tree)).toMatchObject({ status: 'unknown', reason: 'startup_grace' });
  });

  it('startup_grace заканчивается: после окна те же ошибки дают offline', () => {
    const clock = createFakeClock(T0);
    clock.advance(POLICY.startupGraceMs);

    const tree = build([gateway([line([device({ consecutiveErrors: 9 })])])], {
      nowMs: clock.now(),
    });

    expect(firstDevice(tree)).toMatchObject({ status: 'offline', reason: 'consecutive_errors' });
  });

  it('consecutive_errors: offlineAfterErrors подряд ошибок переводят в offline', () => {
    const nowMs = T0 + 600_000;
    const tree = build([
      gateway([line([device({ lastOkAtMs: nowMs - 1_000, consecutiveErrors: 5 })])]),
    ]);

    expect(firstDevice(tree)).toMatchObject({ status: 'offline', reason: 'consecutive_errors' });
  });

  it('на одну ошибку меньше порога прибор ещё online', () => {
    const nowMs = T0 + 600_000;
    const tree = build([
      gateway([line([device({ lastOkAtMs: nowMs - 1_000, consecutiveErrors: 4 })])]),
    ]);

    expect(firstDevice(tree)).toMatchObject({ status: 'online', reason: 'ok' });
  });

  it('stale: успех был, но давно, статус degraded', () => {
    const nowMs = T0 + 600_000;
    const tree = build([
      gateway([line([device({ lastOkAtMs: nowMs - POLICY.staleAfterMs - 1 })])]),
    ]);

    expect(firstDevice(tree)).toMatchObject({ status: 'degraded', reason: 'stale' });
  });

  it('no_data: прибор ни разу не отвечал и ошибок нет', () => {
    const tree = build([gateway([line([device()])])]);

    expect(firstDevice(tree)).toMatchObject({
      status: 'unknown',
      reason: 'no_data',
      lastOkAt: null,
    });
  });

  it('awaiting_success: ошибки идут, но порога offline ещё не набрали', () => {
    const tree = build([gateway([line([device({ consecutiveErrors: 2 })])])]);

    expect(firstDevice(tree)).toMatchObject({ status: 'unknown', reason: 'awaiting_success' });
  });

  it('polling_disabled: выключенная руками линия не делает прибор аварийным', () => {
    const tree = build([
      gateway([line([device({ consecutiveErrors: 9 })], { pollingEnabled: false })]),
    ]);

    expect(firstDevice(tree)).toMatchObject({ status: 'unknown', reason: 'polling_disabled' });
    expect(nodeAt(tree, [0, 0])).toMatchObject({ status: 'unknown', reason: 'polling_disabled' });
  });
});

describe('buildHealthTree: агрегация снизу вверх', () => {
  const nowMs = T0 + 600_000;
  const onlineDevice = device({ code: 'RC-101', lastOkAtMs: nowMs - 1_000 });
  const offlineDevice = device({ code: 'RC-102', consecutiveErrors: 5 });
  const staleDevice = device({ code: 'RC-103', lastOkAtMs: nowMs - POLICY.staleAfterMs - 1 });

  it('линия online, если жив хоть один прибор', () => {
    const tree = build([gateway([line([offlineDevice, onlineDevice])])]);

    expect(nodeAt(tree, [0, 0])).toMatchObject({ status: 'online', reason: 'ok' });
  });

  it('линия offline, если мертвы все приборы', () => {
    const tree = build([gateway([line([offlineDevice, { ...offlineDevice, code: 'RC-104' }])])]);

    expect(nodeAt(tree, [0, 0])).toMatchObject({ status: 'offline' });
  });

  it('children_offline: причина мёртвого родителя указывает на детей', () => {
    const tree = build([gateway([line([offlineDevice])])]);

    expect(nodeAt(tree, [0, 0]).reason).toBe('children_offline');
  });

  it('линия degraded, если приборы живы лишь частично', () => {
    const tree = build([gateway([line([offlineDevice, staleDevice])])]);

    expect(nodeAt(tree, [0, 0])).toMatchObject({ status: 'degraded', reason: 'children_offline' });
  });

  it('шлюз online, если жива хоть одна линия', () => {
    const tree = build([
      gateway([line([offlineDevice], { code: 'L1' }), line([onlineDevice], { code: 'L2' })]),
    ]);

    expect(nodeAt(tree, [0])).toMatchObject({ status: 'online', reason: 'ok' });
  });

  it('шлюз со всеми линиями offline получает unknown: снизу мёртвый шлюз и оборванный кабель неразличимы', () => {
    const tree = build([
      gateway([
        line([offlineDevice], { code: 'L1' }),
        line([{ ...offlineDevice, code: 'RC-105' }], { code: 'L2' }),
      ]),
    ]);
    const gatewayNode = nodeAt(tree, [0]);

    expect(nodeAt(gatewayNode, [0]).status).toBe('offline');
    expect(nodeAt(gatewayNode, [1]).status).toBe('offline');
    expect(gatewayNode.status).toBe('unknown');
    expect(gatewayNode.reason).toBe('children_offline');
  });

  it('узел без детей отдаёт unknown с причиной no_data', () => {
    const tree = build([gateway([])]);

    expect(nodeAt(tree, [0])).toMatchObject({ status: 'unknown', reason: 'no_data' });
  });

  it('родитель складывает ошибки детей и берёт самый свежий успех', () => {
    const tree = build([
      gateway([
        line([{ ...onlineDevice, consecutiveErrors: 1 }], { code: 'L1' }),
        line([{ ...staleDevice, consecutiveErrors: 2 }], { code: 'L2' }),
      ]),
    ]);

    expect(nodeAt(tree, [0]).consecutiveErrors).toBe(3);
    expect(nodeAt(tree, [0]).lastOkAt).toBe(toIsoTimestamp(nowMs - 1_000));
  });

  it('площадка со всеми шлюзами unknown остаётся unknown с причиной children_offline', () => {
    const tree = build([
      gateway([line([offlineDevice], { code: 'L1' })], { code: 'GW-01' }),
      gateway([line([{ ...offlineDevice, code: 'RC-106' }], { code: 'L2' })], { code: 'GW-02' }),
    ]);

    expect(nodeAt(tree, [0]).status).toBe('unknown');
    expect(nodeAt(tree, [1]).status).toBe('unknown');
    expect(tree).toMatchObject({ status: 'unknown', reason: 'children_offline' });
  });

  it('площадка online, если жив хоть один шлюз', () => {
    const tree = build([
      gateway([line([offlineDevice], { code: 'L1' })], { code: 'GW-01' }),
      gateway([line([onlineDevice], { code: 'L2' })], { code: 'GW-02' }),
    ]);

    expect(tree).toMatchObject({ status: 'online', reason: 'ok' });
  });

  it('площадка online, когда все шлюзы online', () => {
    const tree = build([
      gateway([line([onlineDevice], { code: 'L1' })], { code: 'GW-01' }),
      gateway([line([{ ...onlineDevice, code: 'RC-107' }], { code: 'L2' })], { code: 'GW-02' }),
    ]);

    expect(nodeAt(tree, [0]).status).toBe('online');
    expect(nodeAt(tree, [1]).status).toBe('online');
    expect(tree).toMatchObject({ status: 'online', reason: 'ok' });
  });

  it('площадка degraded, если живые шлюзы есть только частично', () => {
    const tree = build([
      gateway([line([staleDevice], { code: 'L1' })], { code: 'GW-01' }),
      gateway([line([offlineDevice], { code: 'L2' })], { code: 'GW-02' }),
    ]);

    expect(nodeAt(tree, [0]).status).toBe('degraded');
    expect(nodeAt(tree, [1]).status).toBe('unknown');
    expect(tree).toMatchObject({ status: 'degraded', reason: 'stale' });
  });

  it('дерево сохраняет форму site -> gateway -> line -> device', () => {
    const tree = build([gateway([line([onlineDevice])])]);

    expect([
      tree.kind,
      nodeAt(tree, [0]).kind,
      nodeAt(tree, [0, 0]).kind,
      nodeAt(tree, [0, 0, 0]).kind,
    ]).toEqual(['site', 'gateway', 'line', 'device']);
    expect(tree.code).toBe('SITE-A');
  });
});

describe('buildHealthTree: момент смены статуса', () => {
  const nowMs = T0 + 600_000;

  it('статус не сменился, since остаётся прежним', () => {
    const tree = build([
      gateway([
        line([
          device({
            lastOkAtMs: nowMs - 1_000,
            prev: { status: 'online', sinceMs: T0 + 1_000 },
          }),
        ]),
      ]),
    ]);

    expect(firstDevice(tree).since).toBe(toIsoTimestamp(T0 + 1_000));
  });

  it('статус сменился, since становится текущим временем', () => {
    const tree = build([
      gateway([
        line([
          device({
            lastOkAtMs: nowMs - 1_000,
            prev: { status: 'offline', sinceMs: T0 + 1_000 },
          }),
        ]),
      ]),
    ]);

    expect(firstDevice(tree).since).toBe(toIsoTimestamp(nowMs));
  });
});

describe('latestOk: самый свежий успех среди детей', () => {
  const okNode = (lastOkAt: string): HealthNode => ({
    kind: 'device',
    code: 'RC-101',
    label: 'Камера 1',
    status: 'online',
    reason: 'ok',
    since: toIsoTimestamp(T0),
    lastOkAt,
    consecutiveErrors: 0,
    children: [],
  });
  const withOffset = '2026-01-01T09:00:00.000+03:00';
  const laterUtc = '2026-01-01T07:00:00.000Z';

  it('ISO со смещением сравнивается по миллисекундам, а не как текст', () => {
    expect(latestOk([okNode(withOffset), okNode(laterUtc)])).toBe(laterUtc);
    expect(latestOk([okNode(laterUtc), okNode(withOffset)])).toBe(laterUtc);
  });

  it('без успехов у детей отдаёт null', () => {
    expect(latestOk([{ ...okNode(laterUtc), lastOkAt: null }])).toBeNull();
  });
});
