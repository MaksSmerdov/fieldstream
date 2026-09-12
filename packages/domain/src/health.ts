import type { HealthNode, HealthPolicy, HealthReason, HealthStatus } from '@fieldstream/contracts';
import { toIsoTimestamp } from './clock.js';

/** Ранее известный статус узла: без него since прыгал бы на каждом пересчёте. */
export interface HealthSnapshot {
  status: HealthStatus;
  sinceMs: number;
}

export interface DeviceHealthInput {
  code: string;
  label: string;
  /** Момент последнего успешного опроса, null если прибор ещё ни разу не ответил. */
  lastOkAtMs: number | null;
  consecutiveErrors: number;
  prev: HealthSnapshot | null;
}

export interface LineHealthInput {
  code: string;
  label: string;
  /** Опрос выключен руками: приборы линии не считаются аварийными. */
  pollingEnabled: boolean;
  devices: readonly DeviceHealthInput[];
  prev: HealthSnapshot | null;
}

export interface GatewayHealthInput {
  code: string;
  label: string;
  lines: readonly LineHealthInput[];
  prev: HealthSnapshot | null;
}

export interface SiteHealthInput {
  code: string;
  label: string;
  gateways: readonly GatewayHealthInput[];
  prev: HealthSnapshot | null;
}

export interface BuildHealthTreeInput {
  site: SiteHealthInput;
  policy: HealthPolicy;
  /** Момент старта опроса: от него отсчитывается окно startup grace. */
  startedAtMs: number;
  nowMs: number;
}

interface Verdict {
  status: HealthStatus;
  reason: HealthReason;
}

/** Момент, с которого держится статус: при смене статуса это текущее время. */
const resolveSince = (prev: HealthSnapshot | null, status: HealthStatus, nowMs: number): number =>
  prev !== null && prev.status === status ? prev.sinceMs : nowMs;

/** Статус прибора по политике здоровья. */
const deviceVerdict = (
  device: DeviceHealthInput,
  input: BuildHealthTreeInput,
  pollingEnabled: boolean,
): Verdict => {
  if (!pollingEnabled) {
    return { status: 'unknown', reason: 'polling_disabled' };
  }

  const { policy, startedAtMs, nowMs } = input;
  const errorsExhausted = device.consecutiveErrors >= policy.offlineAfterErrors;

  if (device.lastOkAtMs === null) {
    if (nowMs - startedAtMs < policy.startupGraceMs) {
      return { status: 'unknown', reason: 'startup_grace' };
    }
    if (errorsExhausted) {
      return { status: 'offline', reason: 'consecutive_errors' };
    }
    return device.consecutiveErrors > 0
      ? { status: 'unknown', reason: 'awaiting_success' }
      : { status: 'unknown', reason: 'no_data' };
  }

  if (errorsExhausted) {
    return { status: 'offline', reason: 'consecutive_errors' };
  }
  if (nowMs - device.lastOkAtMs > policy.staleAfterMs) {
    return { status: 'degraded', reason: 'stale' };
  }
  return { status: 'online', reason: 'ok' };
};

/**
 * Свод по детям: online если жив хоть один, offline только если мертвы все.
 * Вердикт offline осмыслен лишь на уровне линии: молчание детей не доказывает,
 * что мёртв сам шлюз или вся площадка, поэтому выше линии он переводится в unknown.
 */
const aggregate = (children: readonly HealthNode[]): Verdict => {
  const first = children[0];

  if (first === undefined) {
    return { status: 'unknown', reason: 'no_data' };
  }
  if (children.some((child) => child.status === 'online')) {
    return { status: 'online', reason: 'ok' };
  }
  if (children.every((child) => child.status === 'offline')) {
    return { status: 'offline', reason: 'children_offline' };
  }
  if (children.every((child) => child.status === 'unknown')) {
    const shared = children.every((child) => child.reason === first.reason);
    return { status: 'unknown', reason: shared ? first.reason : 'no_data' };
  }
  return {
    status: 'degraded',
    reason: children.some((child) => child.status === 'offline') ? 'children_offline' : 'stale',
  };
};

/** Смерть детей не переносится на родителя: offline выше линии становится unknown. */
const withoutFalseOffline = (summary: Verdict): Verdict =>
  summary.status === 'offline' ? { status: 'unknown', reason: summary.reason } : summary;

/** Сумма ошибок детей: у родителя своего счётчика опроса нет. */
const sumErrors = (children: readonly HealthNode[]): number =>
  children.reduce((acc, child) => acc + child.consecutiveErrors, 0);

/**
 * Самый свежий успех среди детей. Сравниваются миллисекунды, а не текст строки:
 * контракты разрешают ISO со смещением, и лексикографически такая строка встаёт не туда.
 */
export const latestOk = (children: readonly HealthNode[]): string | null =>
  children.reduce<string | null>(
    (acc, child) =>
      child.lastOkAt !== null && (acc === null || Date.parse(child.lastOkAt) > Date.parse(acc))
        ? child.lastOkAt
        : acc,
    null,
  );

/** Узел прибора со статусом и машинной причиной. */
const buildDeviceNode = (
  device: DeviceHealthInput,
  input: BuildHealthTreeInput,
  pollingEnabled: boolean,
): HealthNode => {
  const verdict = deviceVerdict(device, input, pollingEnabled);

  return {
    kind: 'device',
    code: device.code,
    label: device.label,
    status: verdict.status,
    reason: verdict.reason,
    since: toIsoTimestamp(resolveSince(device.prev, verdict.status, input.nowMs)),
    lastOkAt: device.lastOkAtMs === null ? null : toIsoTimestamp(device.lastOkAtMs),
    consecutiveErrors: device.consecutiveErrors,
    children: [],
  };
};

/** Узел линии: выключенный опрос не превращается в аварию. */
const buildLineNode = (line: LineHealthInput, input: BuildHealthTreeInput): HealthNode => {
  const devices = line.devices.map((device) => buildDeviceNode(device, input, line.pollingEnabled));
  const verdict: Verdict = line.pollingEnabled
    ? aggregate(devices)
    : { status: 'unknown', reason: 'polling_disabled' };

  return {
    kind: 'line',
    code: line.code,
    label: line.label,
    status: verdict.status,
    reason: verdict.reason,
    since: toIsoTimestamp(resolveSince(line.prev, verdict.status, input.nowMs)),
    lastOkAt: latestOk(devices),
    consecutiveErrors: sumErrors(devices),
    children: devices,
  };
};

/** Узел шлюза. Молчание всех линий даёт unknown, см. правило свода выше. */
const buildGatewayNode = (gateway: GatewayHealthInput, input: BuildHealthTreeInput): HealthNode => {
  const lines = gateway.lines.map((line) => buildLineNode(line, input));
  const verdict = withoutFalseOffline(aggregate(lines));

  return {
    kind: 'gateway',
    code: gateway.code,
    label: gateway.label,
    status: verdict.status,
    reason: verdict.reason,
    since: toIsoTimestamp(resolveSince(gateway.prev, verdict.status, input.nowMs)),
    lastOkAt: latestOk(lines),
    consecutiveErrors: sumErrors(lines),
    children: lines,
  };
};

/** Строит дерево здоровья site -> gateway -> line -> device на один момент времени. */
export const buildHealthTree = (input: BuildHealthTreeInput): HealthNode => {
  const gateways = input.site.gateways.map((gateway) => buildGatewayNode(gateway, input));
  const verdict = withoutFalseOffline(aggregate(gateways));

  return {
    kind: 'site',
    code: input.site.code,
    label: input.site.label,
    status: verdict.status,
    reason: verdict.reason,
    since: toIsoTimestamp(resolveSince(input.site.prev, verdict.status, input.nowMs)),
    lastOkAt: latestOk(gateways),
    consecutiveErrors: sumErrors(gateways),
    children: gateways,
  };
};
