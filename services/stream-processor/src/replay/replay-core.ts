import { replayRulesSnapshotSchema } from '@fieldstream/contracts';
import type { AlarmRule, ReplayVariant, TelemetryRaw } from '@fieldstream/contracts';
import type { DeviceRef, ReplayEpisodeRow, ReplayRunRules } from '@fieldstream/db';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { AlarmTransition, DeviceAlarmState, SpikeFilterState } from '@fieldstream/domain';
import { evaluateFrameAlarms } from '../ingest/alarms.js';
import { processFrame } from '../ingest/frame.js';

/** Предел эпизодов одного варианта: дальше прогон завершается с ошибкой, а не съедает память. */
export const REPLAY_MAX_EPISODES = 20_000;

/** Как варианты называются в интерфейсе: столбцы «Было» и «Стало». */
const VARIANT_LABEL: Readonly<Record<ReplayVariant, string>> = Object.freeze({
  baseline: 'было',
  patched: 'стало',
});

/** Уставки обоих вариантов прогона. */
export interface ReplayRules {
  readonly baseline: readonly AlarmRule[];
  readonly patched: readonly AlarmRule[];
}

/** Эпизодов варианта больше предела: прогон завершается с этим текстом. */
export class ReplayLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReplayLimitError';
  }
}

/** Снимок уставок одного варианта общей схемой контрактов. */
const parseVariant = (value: unknown, variant: ReplayVariant): AlarmRule[] => {
  const parsed = replayRulesSnapshotSchema.safeParse(value);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`снимок уставок «${VARIANT_LABEL[variant]}» в прогоне не разобран: ${issues}`);
};

/**
 * Уставки прогона берутся из его строки, а не из живой таблицы: прогон воспроизводим, даже если
 * уставки успели поправить после запроса.
 */
export const parseReplayRules = (rules: ReplayRunRules): ReplayRules => ({
  baseline: parseVariant(rules.baseline, 'baseline'),
  patched: parseVariant(rules.patched, 'patched'),
});

/** Что нужно ядру: окно, выбранные приборы, топология и уставки обоих вариантов. */
export interface ReplayCoreInput {
  readonly from: string;
  readonly to: string;
  readonly deviceCodes: readonly string[];
  readonly refs: ReadonlyMap<string, DeviceRef>;
  readonly rules: ReplayRules;
  readonly maxEpisodes?: number;
}

/** Откуда кадр: партиция и смещение сырого топика. */
export interface ReplaySource {
  readonly partition: number;
  readonly offset: string;
}

/** Исход кадра: чужой или вне окна, принят в расчёт или отвергнут. */
export type ReplayFrameVerdict = 'ignored' | 'matched' | 'rejected';

/** Счёты прогона и покрытие окна: время первого и последнего принятого кадра. */
export interface ReplayCounts {
  readonly framesMatched: number;
  readonly framesRejected: number;
  readonly coveredFrom: string | null;
  readonly coveredTo: string | null;
}

/** Ядро перепрогона: кадр за кадром, затем счёты и эпизоды обоих вариантов. */
export interface ReplayCore {
  readonly frame: (raw: TelemetryRaw, source: ReplaySource) => ReplayFrameVerdict;
  readonly undecodable: (deviceCode: string | null) => ReplayFrameVerdict;
  readonly counts: () => ReplayCounts;
  readonly episodes: () => ReplayEpisodeRow[];
}

/** Память одного варианта: алармы приборов, эпизоды и открытые из них. */
interface VariantMemory {
  readonly variant: ReplayVariant;
  readonly rules: ReadonlyMap<string, readonly AlarmRule[]>;
  readonly alarms: Map<string, DeviceAlarmState>;
  readonly episodes: ReplayEpisodeRow[];
  readonly open: Map<string, number>;
}

const NO_RULES: readonly AlarmRule[] = Object.freeze([]);

/** Ключ эпизода: у подъёма и снятия общий момент подъёма. */
const episodeKey = (deviceCode: string, metricKey: string, raisedAtMs: number): string =>
  `${deviceCode}|${metricKey}|${String(raisedAtMs)}`;

/** Уставки выбранных приборов по коду прибора. */
const rulesByDevice = (
  rules: readonly AlarmRule[],
  selected: ReadonlySet<string>,
): Map<string, AlarmRule[]> => {
  const byDevice = new Map<string, AlarmRule[]>();
  for (const rule of rules) {
    if (!selected.has(rule.deviceCode)) continue;
    const list = byDevice.get(rule.deviceCode);
    if (list === undefined) byDevice.set(rule.deviceCode, [rule]);
    else list.push(rule);
  }
  return byDevice;
};

const memoryOf = (
  variant: ReplayVariant,
  rules: readonly AlarmRule[],
  selected: ReadonlySet<string>,
): VariantMemory => ({
  variant,
  rules: rulesByDevice(rules, selected),
  alarms: new Map(),
  episodes: [],
  open: new Map(),
});

/** Переходы кадра в эпизоды варианта: подъём открывает эпизод, снятие закрывает его. */
const applyTransitions = (
  memory: VariantMemory,
  transitions: readonly AlarmTransition[],
  deviceId: number,
  maxEpisodes: number,
): void => {
  for (const transition of transitions) {
    const key = episodeKey(transition.deviceCode, transition.metricKey, transition.raisedAt);

    if (transition.state === 'raised') {
      if (memory.episodes.length >= maxEpisodes) {
        throw new ReplayLimitError(
          `эпизодов в варианте «${VARIANT_LABEL[memory.variant]}» больше ${String(maxEpisodes)}: сузьте окно, выберите меньше приборов или смягчите правку`,
        );
      }
      memory.open.set(key, memory.episodes.length);
      memory.episodes.push({
        variant: memory.variant,
        deviceId,
        metricKey: transition.metricKey,
        mode: transition.mode,
        severity: transition.severity,
        boundary: transition.boundary,
        value: transition.value,
        threshold: transition.threshold,
        raisedAt: toIsoTimestamp(transition.raisedAt),
        clearedAt: null,
        clearedValue: null,
      });
      continue;
    }

    const index = memory.open.get(key);
    const episode = index === undefined ? undefined : memory.episodes[index];
    if (index === undefined || episode === undefined) continue;
    memory.episodes[index] = {
      ...episode,
      clearedAt: toIsoTimestamp(transition.occurredAt),
      clearedValue: transition.value,
    };
    memory.open.delete(key);
  }
};

/**
 * Ядро перепрогона без ввода-вывода: память меняется на месте, время берётся только из кадров.
 * Кадр чужого прибора или вне окна [from, to) по времени кадра пропускается. Кадр прибора не позже
 * последнего принятого по нему отвергается: иначе снятие могло бы оказаться раньше подъёма.
 * Принятый кадр проходит тот же разбор и фильтр скачков, что вживую, и оценивается дважды,
 * уставками «было» и «стало». Оба варианта начинают с пустой памяти, поэтому сравнение не зависит
 * от живой базы. Открытые к концу окна эпизоды остаются без снятия.
 */
export const createReplayCore = (input: ReplayCoreInput): ReplayCore => {
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  const maxEpisodes = input.maxEpisodes ?? REPLAY_MAX_EPISODES;
  const selected = new Set(input.deviceCodes);
  const filters = new Map<string, SpikeFilterState>();
  const lastAccepted = new Map<string, number>();
  const variants = [
    memoryOf('baseline', input.rules.baseline, selected),
    memoryOf('patched', input.rules.patched, selected),
  ];
  let matched = 0;
  let rejected = 0;
  let coveredFromMs: number | null = null;
  let coveredToMs: number | null = null;

  const reject = (): ReplayFrameVerdict => {
    rejected += 1;
    return 'rejected';
  };

  const frame = (raw: TelemetryRaw, source: ReplaySource): ReplayFrameVerdict => {
    if (!selected.has(raw.deviceCode)) return 'ignored';
    const atMs = Date.parse(raw.ts);
    if (!(atMs >= fromMs && atMs < toMs)) return 'ignored';

    const last = lastAccepted.get(raw.deviceCode);
    if (last !== undefined && atMs <= last) return reject();

    const deviceId = input.refs.get(raw.deviceCode)?.deviceId;
    const outcome = processFrame(raw, { refs: input.refs, filters, source });
    if (outcome.kind === 'rejected' || deviceId === undefined) return reject();

    for (const [key, state] of outcome.filters) filters.set(key, state);
    lastAccepted.set(raw.deviceCode, atMs);
    matched += 1;
    coveredFromMs = coveredFromMs === null ? atMs : Math.min(coveredFromMs, atMs);
    coveredToMs = coveredToMs === null ? atMs : Math.max(coveredToMs, atMs);

    for (const memory of variants) {
      const evaluated = evaluateFrameAlarms({
        observation: outcome.observation,
        rows: outcome.rows,
        rules: memory.rules.get(raw.deviceCode) ?? NO_RULES,
        prevState: memory.alarms.get(raw.deviceCode) ?? {},
      });
      memory.alarms.set(raw.deviceCode, evaluated.state);
      applyTransitions(memory, evaluated.transitions, deviceId, maxEpisodes);
    }

    return 'matched';
  };

  const undecodable = (deviceCode: string | null): ReplayFrameVerdict =>
    deviceCode !== null && selected.has(deviceCode) ? reject() : 'ignored';

  const counts = (): ReplayCounts => ({
    framesMatched: matched,
    framesRejected: rejected,
    coveredFrom: coveredFromMs === null ? null : toIsoTimestamp(coveredFromMs),
    coveredTo: coveredToMs === null ? null : toIsoTimestamp(coveredToMs),
  });

  const episodes = (): ReplayEpisodeRow[] => variants.flatMap((memory) => memory.episodes);

  return { frame, undecodable, counts, episodes };
};
