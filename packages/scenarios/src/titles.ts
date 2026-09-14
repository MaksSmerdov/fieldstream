import { lineCodeSchema } from '@fieldstream/contracts';
import type {
  BreakerState,
  DeviceMode,
  HealthReason,
  HealthStatus,
  LineStatus,
  SimFaultKind,
  SimScenarioName,
} from '@fieldstream/contracts';
import type { Probe, ProbeOf, ScenarioStep, StepOf } from './schema.js';

/** Поломки стенда человеческими словами. */
export const FAULT_NAMES: Readonly<Record<SimFaultKind, string>> = {
  silent: 'молчит',
  crc: 'мусор в кадре',
  stall: 'зависает на ответе',
  exception: 'отвечает исключением',
  offline: 'обрыв порта',
  power_dip: 'просадка питания',
  offscale: 'значение за шкалой',
  door_stuck: 'дверь не закрывается',
  defrost: 'оттайка',
};

/** Сценарии симулятора человеческими словами. */
export const SIM_SCENARIO_NAMES: Readonly<Record<SimScenarioName, string>> = {
  'night-defrost': 'ночная оттайка',
  'power-dip': 'просадка питания',
  'door-left-open': 'дверь оставили открытой',
  'line-blackout': 'обрыв линии',
};

/** Состояние размыкателя сейчас. */
export const BREAKER_STATE_WORDS: Readonly<Record<BreakerState, string>> = {
  closed: 'замкнут',
  open: 'разомкнут',
  half_open: 'полуразомкнут, идёт проба',
};

/** Переход размыкателя, которого ждут. */
const BREAKER_UNTIL_WORDS: Readonly<Record<BreakerState, string>> = {
  closed: 'замкнётся',
  open: 'разомкнётся',
  half_open: 'перейдёт в пробу',
};

/** Статус прибора сейчас. */
export const STATUS_WORDS: Readonly<Record<HealthStatus, string>> = {
  online: 'на связи',
  offline: 'не на связи',
  degraded: 'работает с перебоями',
  unknown: 'в неизвестном статусе',
};

/** Переход статуса прибора, которого ждут. */
const STATUS_UNTIL_WORDS: Readonly<Record<HealthStatus, string>> = {
  online: 'выйдет на связь',
  offline: 'пропадёт со связи',
  degraded: 'начнёт работать с перебоями',
  unknown: 'перейдёт в неизвестный статус',
};

/** Причина статуса прибора. */
export const REASON_WORDS: Readonly<Record<HealthReason, string>> = {
  ok: 'всё в порядке',
  consecutive_errors: 'отказы подряд',
  stale: 'данные устарели',
  no_data: 'данных ещё нет',
  awaiting_success: 'ещё ни одного успешного ответа',
  startup_grace: 'идёт окно запуска',
  polling_disabled: 'опрос выключен',
  children_offline: 'все приборы ниже не на связи',
};

/** Режим холодильного контроллера. */
export const MODE_NAMES: Readonly<Record<DeviceMode, string>> = {
  cooling: 'охлаждение',
  defrost: 'оттайка',
  service: 'обслуживание',
  off: 'выключен',
};

/** Чем закончился обход линии. */
export const CYCLE_OUTCOME_WORDS: Readonly<
  Record<NonNullable<LineStatus['lastCycle']>['outcome'], string>
> = {
  polled: 'опрос приборов',
  idle: 'простой, опрашивать некого',
  disconnected: 'порт не подключён',
  watchdog: 'прерван сторожем',
};

/** Причина статуса в скобках для заголовка. */
const reasonClause = (reason: HealthReason | undefined): string =>
  reason === undefined ? '' : ` (причина: ${REASON_WORDS[reason]})`;

/** Код линии или прибора: у линии вид L1. */
const isLineCode = (code: string): boolean => lineCodeSchema.safeParse(code).success;

/** Хвост « по metricKey», если метрика задана. */
const metricScope = (metricKey: string | undefined): string =>
  metricKey === undefined ? '' : ` по ${metricKey}`;

/** Ожидаемый переход прибора. */
const deviceUntil = (probe: ProbeOf<'device'>): string => {
  const clauses: string[] = [];

  if (probe.status !== undefined) {
    clauses.push(`${STATUS_UNTIL_WORDS[probe.status]}${reasonClause(probe.reason)}`);
  } else if (probe.reason !== undefined) {
    clauses.push(`получит причину статуса «${REASON_WORDS[probe.reason]}»`);
  }
  if (probe.mode !== undefined) clauses.push(`перейдёт в режим «${MODE_NAMES[probe.mode]}»`);

  return `прибор ${probe.deviceCode} ${clauses.join(' и ')}`;
};

/** Удерживаемое состояние прибора. */
const deviceState = (probe: ProbeOf<'device'>): string => {
  const clauses: string[] = [];

  if (probe.status !== undefined) {
    clauses.push(`${STATUS_WORDS[probe.status]}${reasonClause(probe.reason)}`);
  } else if (probe.reason !== undefined) {
    clauses.push(`с причиной статуса «${REASON_WORDS[probe.reason]}»`);
  }
  if (probe.mode !== undefined) clauses.push(`в режиме «${MODE_NAMES[probe.mode]}»`);

  return `прибор ${probe.deviceCode} ${clauses.join(' и ')}`;
};

/** Ожидаемый переход линии. */
const lineUntil = (probe: ProbeOf<'line'>): string => {
  const clauses: string[] = [];

  if (probe.connected !== undefined) clauses.push(probe.connected ? 'подключится' : 'отключится');
  if (probe.reconnectsAtLeast !== undefined) {
    clauses.push(
      `наберёт с начала прогона не меньше ${probe.reconnectsAtLeast} попыток переподключения`,
    );
  }
  if (probe.durationWithinPct !== undefined) {
    const { of, pct } = probe.durationWithinPct;
    clauses.push(`уложит обход в базовый «${of}» плюс ${pct}%`);
  }

  return `линия ${probe.lineCode} ${clauses.join(', ')}`;
};

/** Удерживаемое состояние линии. */
const lineState = (probe: ProbeOf<'line'>): string => {
  const clauses: string[] = [];

  if (probe.connected !== undefined) clauses.push(probe.connected ? 'подключена' : 'не подключена');
  if (probe.reconnectsAtLeast !== undefined) {
    clauses.push(
      `набрала с начала прогона не меньше ${probe.reconnectsAtLeast} попыток переподключения`,
    );
  }
  if (probe.durationWithinPct !== undefined) {
    const { of, pct } = probe.durationWithinPct;
    clauses.push(`обходится не дольше базового «${of}» плюс ${pct}%`);
  }

  return `линия ${probe.lineCode} ${clauses.join(', ')}`;
};

/** Проба как событие, которого ждут: «размыкатель RC-105 разомкнётся». */
export const describeProbeUntil = (probe: Probe): string => {
  switch (probe.kind) {
    case 'breaker':
      return `размыкатель ${probe.deviceCode} ${BREAKER_UNTIL_WORDS[probe.state]}`;
    case 'device':
      return deviceUntil(probe);
    case 'line':
      return lineUntil(probe);
    case 'alarm':
      return probe.active
        ? `по ${probe.deviceCode} поднимется аларм${probe.metricKey === undefined ? '' : ` ${probe.metricKey}`}`
        : `по ${probe.deviceCode} не останется активных алармов${metricScope(probe.metricKey)}`;
    case 'noAlarmsRaised':
      return `с начала прогона не будет поднятых алармов${metricScope(probe.metricKey)}`;
    case 'dlqUnchanged':
      return 'очередь недоставленных вернётся к размеру на старте';
  }
};

/** Проба как состояние, которое держится: «размыкатель RC-105 разомкнут». */
export const describeProbeState = (probe: Probe): string => {
  switch (probe.kind) {
    case 'breaker':
      return `размыкатель ${probe.deviceCode} ${BREAKER_STATE_WORDS[probe.state]}`;
    case 'device':
      return deviceState(probe);
    case 'line':
      return lineState(probe);
    case 'alarm':
      return probe.active
        ? `по ${probe.deviceCode} активен аларм${probe.metricKey === undefined ? '' : ` ${probe.metricKey}`}`
        : `по ${probe.deviceCode} нет активных алармов${metricScope(probe.metricKey)}`;
    case 'noAlarmsRaised':
      return `не поднимаются новые алармы${metricScope(probe.metricKey)}`;
    case 'dlqUnchanged':
      return 'очередь недоставленных не растёт';
  }
};

/** Поломка с уточнением: параметр за шкалой или код исключения. */
const faultWithDetail = (step: StepOf<'inject'>): string => {
  const { request } = step;
  const name = `«${FAULT_NAMES[request.kind]}»`;

  if (request.kind === 'offscale' && request.paramKey !== undefined) {
    return `${name} (${request.paramKey})`;
  }
  if (request.kind === 'exception') return `${name} (код ${request.exceptionCode})`;
  return name;
};

/** Снятие поломок человеческими словами. */
const clearTitle = (step: StepOf<'clear'>): string => {
  const { targetId, kind } = step.filter;
  const from =
    targetId === undefined ? '' : ` с ${isLineCode(targetId) ? `линии ${targetId}` : targetId}`;

  if (kind === undefined)
    return targetId === undefined ? 'Снять все поломки стенда' : `Снять все поломки${from}`;
  return `Снять ${targetId === undefined ? 'все поломки' : 'поломку'} «${FAULT_NAMES[kind]}»${from}`;
};

/** Человеческое описание шага для интерфейса и отчёта CI. */
export const describeStep = (step: ScenarioStep): string => {
  switch (step.kind) {
    case 'inject': {
      const { targetId, ttlSec } = step.request;
      const target = isLineCode(targetId) ? `линию ${targetId}` : targetId;
      return `Внести поломку ${faultWithDetail(step)} на ${target} на ${ttlSec} с`;
    }
    case 'clear':
      return clearTitle(step);
    case 'simScenario':
      return `Запустить сценарий стенда «${SIM_SCENARIO_NAMES[step.name]}»`;
    case 'baseline':
      return `Запомнить среднюю длительность обхода линии ${step.line} по ${step.samples} обходам как «${step.as}»`;
    case 'waitFor':
      return `Дождаться, пока ${describeProbeUntil(step.probe)}, не дольше ${step.timeoutSec} с`;
    case 'hold':
      return `Проверять ${step.forSec} с, что ${describeProbeState(step.probe)}`;
  }
};
