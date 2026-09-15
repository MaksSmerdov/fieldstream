import type {
  BreakerState,
  DeviceMode,
  HealthReason,
  HealthStatus,
  LineStatus,
} from '@fieldstream/contracts';
import type { Probe, ProbeOf } from './schema.js';
import {
  BREAKER_STATE_WORDS,
  CYCLE_OUTCOME_WORDS,
  MODE_NAMES,
  REASON_WORDS,
  STATUS_WORDS,
} from './titles.js';

/** Здоровье и режим прибора. У счётчиков режима нет. */
export interface DeviceFacts {
  readonly status: HealthStatus;
  readonly reason: HealthReason;
  readonly mode: DeviceMode | null;
}

/** Чем закончился обход линии: длительность показательна только у опросного. */
export type CycleOutcome = NonNullable<LineStatus['lastCycle']>['outcome'];

/** Последний завершённый обход линии. */
export interface LineCycleFacts {
  readonly at: string;
  readonly outcome: CycleOutcome;
  readonly durationMs: number;
}

/**
 * Линия глазами сборщика. reconnects это попытки переподключения из снимка линии, сделанные
 * не раньше начала прогона: история в снимке после подключения не сбрасывается.
 */
export interface LineFacts {
  readonly connected: boolean;
  readonly reconnects: number;
  readonly lastCycle: LineCycleFacts | null;
}

/** Активный аларм. */
export interface AlarmFacts {
  readonly deviceCode: string;
  readonly metricKey: string;
}

/** Снимок фактов стенда, по которому оцениваются пробы. */
export interface StandFacts {
  readonly breakers: Readonly<Record<string, BreakerState>>;
  readonly devices: Readonly<Record<string, DeviceFacts>>;
  readonly lines: Readonly<Record<string, LineFacts>>;
  readonly activeAlarms: readonly AlarmFacts[];
  readonly alarmsRaisedSinceStart: Readonly<Record<string, number>>;
  readonly dlqTotal: number;
}

/** То, что прогон запомнил: базовые длительности и очередь недоставленных на старте. */
export interface ProbeContext {
  readonly baselines: Readonly<Record<string, number>>;
  readonly dlqAtStart: number;
}

/** Итог пробы: observed коротко говорит, что увидели. */
export interface ProbeOutcome {
  readonly ok: boolean;
  readonly observed: string;
}

/** Число попыток переподключения из снимка линии, сделанных не раньше startedAt. */
export const countReconnectsSince = (
  attempts: readonly { readonly at: string }[],
  startedAt: string,
): number => {
  const fromMs = Date.parse(startedAt);
  return attempts.filter((attempt) => Date.parse(attempt.at) >= fromMs).length;
};

/** Отклонение в процентах со знаком: +8%, -12%, ±0%. */
const signedPct = (value: number): string => {
  const rounded = Math.round(value);
  if (rounded === 0) return '±0%';
  return rounded > 0 ? `+${rounded}%` : `${rounded}%`;
};

/** Прибор, которого нет в снимке. */
const missingDevice = (deviceCode: string): ProbeOutcome => ({
  ok: false,
  observed: `${deviceCode}: прибора нет в снимке стенда`,
});

/** Размыкатель прибора в нужном состоянии. */
const breakerOutcome = (probe: ProbeOf<'breaker'>, facts: StandFacts): ProbeOutcome => {
  const state = facts.breakers[probe.deviceCode];
  if (state === undefined) {
    return { ok: false, observed: `${probe.deviceCode}: размыкателя нет в снимке стенда` };
  }

  return {
    ok: state === probe.state,
    observed: `${probe.deviceCode}: размыкатель ${BREAKER_STATE_WORDS[state]}`,
  };
};

/** Статус, причина и режим прибора совпадают с заданными. */
const deviceOutcome = (probe: ProbeOf<'device'>, facts: StandFacts): ProbeOutcome => {
  const device = facts.devices[probe.deviceCode];
  if (device === undefined) return missingDevice(probe.deviceCode);

  const ok =
    (probe.status === undefined || device.status === probe.status) &&
    (probe.reason === undefined || device.reason === probe.reason) &&
    (probe.mode === undefined || device.mode === probe.mode);

  const reason = device.reason === 'ok' ? '' : ` (${REASON_WORDS[device.reason]})`;
  const parts = [`${STATUS_WORDS[device.status]}${reason}`];
  if (device.mode !== null) parts.push(`режим «${MODE_NAMES[device.mode]}»`);
  else if (probe.mode !== undefined) parts.push('режима не сообщает');

  return { ok, observed: `${probe.deviceCode}: ${parts.join(', ')}` };
};

/** Длительность опросного обхода не выросла над базовой больше чем на pct процентов. */
const durationOutcome = (
  line: LineFacts,
  limit: { readonly of: string; readonly pct: number },
  context: ProbeContext,
): ProbeOutcome => {
  const base = context.baselines[limit.of];
  if (base === undefined) {
    return { ok: false, observed: `базовая длительность «${limit.of}» не снята` };
  }
  if (line.lastCycle === null) return { ok: false, observed: 'обходов ещё не было' };

  const { durationMs, outcome } = line.lastCycle;
  if (outcome !== 'polled') {
    return {
      ok: false,
      observed: `последний обход не опросный (${CYCLE_OUTCOME_WORDS[outcome]}), длительность не показательна`,
    };
  }

  const delta = base > 0 ? `, ${signedPct(((durationMs - base) / base) * 100)}` : '';

  return {
    ok: durationMs <= base * (1 + limit.pct / 100),
    observed: `обход ${durationMs} мс, базовый ${Math.round(base)} мс${delta}`,
  };
};

/** Все заданные условия по линии. */
const lineOutcome = (
  probe: ProbeOf<'line'>,
  facts: StandFacts,
  context: ProbeContext,
): ProbeOutcome => {
  const line = facts.lines[probe.lineCode];
  if (line === undefined) {
    return { ok: false, observed: `${probe.lineCode}: линии нет в снимке стенда` };
  }

  const checks: ProbeOutcome[] = [];
  if (probe.connected !== undefined) {
    checks.push({
      ok: line.connected === probe.connected,
      observed: line.connected ? 'порт подключён' : 'порт не подключён',
    });
  }
  if (probe.reconnectsAtLeast !== undefined) {
    checks.push({
      ok: line.reconnects >= probe.reconnectsAtLeast,
      observed: `попыток переподключения с начала прогона ${line.reconnects}`,
    });
  }
  if (probe.durationWithinPct !== undefined) {
    checks.push(durationOutcome(line, probe.durationWithinPct, context));
  }

  return {
    ok: checks.every((check) => check.ok),
    observed: `${probe.lineCode}: ${checks.map((check) => check.observed).join(', ')}`,
  };
};

/** Активен ли аларм прибора, при заданной метрике только по ней. */
const alarmOutcome = (probe: ProbeOf<'alarm'>, facts: StandFacts): ProbeOutcome => {
  if (facts.devices[probe.deviceCode] === undefined) return missingDevice(probe.deviceCode);

  const metrics = new Set(
    facts.activeAlarms
      .filter(
        (alarm) =>
          alarm.deviceCode === probe.deviceCode &&
          (probe.metricKey === undefined || alarm.metricKey === probe.metricKey),
      )
      .map((alarm) => alarm.metricKey),
  );
  const scope = probe.metricKey === undefined ? '' : ` по ${probe.metricKey}`;

  return {
    ok: metrics.size > 0 === probe.active,
    observed:
      metrics.size > 0
        ? `${probe.deviceCode}: активен аларм ${[...metrics].join(', ')}`
        : `${probe.deviceCode}: активных алармов${scope} нет`,
  };
};

/** С начала прогона не поднялось ни одного аларма, при заданной метрике только по ней. */
const noAlarmsRaisedOutcome = (
  probe: ProbeOf<'noAlarmsRaised'>,
  facts: StandFacts,
): ProbeOutcome => {
  const raised = facts.alarmsRaisedSinceStart;
  const count =
    probe.metricKey === undefined
      ? Object.values(raised).reduce((sum, value) => sum + value, 0)
      : (raised[probe.metricKey] ?? 0);
  const scope = probe.metricKey === undefined ? '' : ` по ${probe.metricKey}`;

  return { ok: count === 0, observed: `с начала прогона поднято алармов${scope}: ${count}` };
};

/** Очередь недоставленных не выросла с начала прогона. */
const dlqOutcome = (facts: StandFacts, context: ProbeContext): ProbeOutcome => {
  const growth = facts.dlqTotal - context.dlqAtStart;
  const tail = growth > 0 ? `, +${growth}` : '';

  return {
    ok: growth <= 0,
    observed: `в очереди недоставленных ${facts.dlqTotal}, на старте было ${context.dlqAtStart}${tail}`,
  };
};

/** Оценивает пробу по снимку фактов. Чего нет в снимке, то не подтверждено. */
export const evaluateProbe = (
  probe: Probe,
  facts: StandFacts,
  context: ProbeContext,
): ProbeOutcome => {
  switch (probe.kind) {
    case 'breaker':
      return breakerOutcome(probe, facts);
    case 'device':
      return deviceOutcome(probe, facts);
    case 'line':
      return lineOutcome(probe, facts, context);
    case 'alarm':
      return alarmOutcome(probe, facts);
    case 'noAlarmsRaised':
      return noAlarmsRaisedOutcome(probe, facts);
    case 'dlqUnchanged':
      return dlqOutcome(facts, context);
  }
};
