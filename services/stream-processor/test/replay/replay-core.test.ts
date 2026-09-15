import { describe, expect, it } from 'vitest';
import type { AlarmRule, RawBlock, TelemetryRaw } from '@fieldstream/contracts';
import type { DeviceRef } from '@fieldstream/db';
import {
  buildDeviceReadPlan,
  buildSimulationValues,
  encodeSimulationRegisters,
  rc2000Profile,
  readSimulatedBlock,
} from '@fieldstream/device-profiles';
import type { DecodedValue } from '@fieldstream/modbus-codec';
import {
  ReplayLimitError,
  createReplayCore,
  parseReplayRules,
} from '../../src/replay/replay-core.js';
import type { ReplayCoreInput } from '../../src/replay/replay-core.js';

const DEVICE = 'RC-101';
const OTHER = 'RC-102';
const FROM_MS = Date.parse('2026-09-11T10:00:00.000Z');
const TO_MS = FROM_MS + 10 * 60_000;
const CYCLE_MS = 10_000;
const SOURCE = { partition: 0, offset: '0' };

const REFS = new Map<string, DeviceRef>([
  [DEVICE, { deviceId: 1, lineId: 1, code: DEVICE, lineCode: 'L1', siteCode: 'SITE-A' }],
  [OTHER, { deviceId: 2, lineId: 1, code: OTHER, lineCode: 'L1', siteCode: 'SITE-A' }],
]);

/** Уставка испарителя в оттайке: граница 12 как на стенде. */
const evapDefrost = (deviceCode: string, maxValue: number): AlarmRule => ({
  deviceCode,
  metricKey: 'evap_temp_c',
  mode: 'defrost',
  minValue: -28,
  maxValue,
  hysteresis: 1,
  debounceCycles: 6,
  severity: 'info',
  enabled: true,
});

const RULES = {
  baseline: [evapDefrost(DEVICE, 12), evapDefrost(OTHER, 12)],
  patched: [evapDefrost(DEVICE, 8), evapDefrost(OTHER, 8)],
};

/** Блоки кадра оттайки с заданной температурой испарителя, остальное спокойно. */
const defrostBlocks = (evap: number): RawBlock[] => {
  const values = new Map<string, DecodedValue>([
    ...buildSimulationValues(rc2000Profile, 36),
    ['defrost_state', 'heating'],
    ['evap_temp_c', evap],
  ]);
  const registers = encodeSimulationRegisters(rc2000Profile, values);
  return buildDeviceReadPlan(rc2000Profile).blocks.map((block) => ({
    registerType: block.registerType,
    startAddress: block.startAddress,
    words: readSimulatedBlock(registers, block),
  }));
};

const frameAt = (atMs: number, evap: number, patch: Partial<TelemetryRaw> = {}): TelemetryRaw => ({
  schema: 'telemetry.raw',
  v: 1,
  ts: new Date(atMs).toISOString(),
  siteCode: 'SITE-A',
  gatewayCode: 'GW-01',
  lineCode: 'L1',
  deviceCode: DEVICE,
  slaveId: 1,
  profileKey: rc2000Profile.profileKey,
  profileVersion: rc2000Profile.version,
  blocks: defrostBlocks(evap),
  cycleMs: 40,
  traceId: atMs.toString(16).padStart(16, '0'),
  ...patch,
});

/** Серия кадров оттайки с шагом опроса, начиная с цикла first. */
const series = (first: number, values: readonly number[]): TelemetryRaw[] =>
  values.map((evap, index) => frameAt(FROM_MS + (first + index) * CYCLE_MS, evap));

const core = (patch: Partial<ReplayCoreInput> = {}) =>
  createReplayCore({
    from: new Date(FROM_MS).toISOString(),
    to: new Date(TO_MS).toISOString(),
    deviceCodes: [DEVICE],
    refs: REFS,
    rules: RULES,
    ...patch,
  });

describe('ядро перепрогона', () => {
  it('граница 8 в оттайке даёт эпизод, граница 12 нет, снятие закрывает эпизод', () => {
    const replay = core();
    const verdicts = series(0, [10, 10, 10, 10, 10, 10, 10, 10, 6]).map((frame) =>
      replay.frame(frame, SOURCE),
    );

    expect(verdicts.every((verdict) => verdict === 'matched')).toBe(true);
    const episodes = replay.episodes();
    expect(episodes.filter((episode) => episode.variant === 'baseline')).toEqual([]);
    expect(episodes).toEqual([
      {
        variant: 'patched',
        deviceId: 1,
        metricKey: 'evap_temp_c',
        mode: 'defrost',
        severity: 'info',
        boundary: 'max',
        value: 10,
        threshold: 8,
        raisedAt: new Date(FROM_MS + 5 * CYCLE_MS).toISOString(),
        clearedAt: new Date(FROM_MS + 8 * CYCLE_MS).toISOString(),
        clearedValue: 6,
      },
    ]);
    expect(replay.counts()).toEqual({
      framesMatched: 9,
      framesRejected: 0,
      coveredFrom: new Date(FROM_MS).toISOString(),
      coveredTo: new Date(FROM_MS + 8 * CYCLE_MS).toISOString(),
    });
  });

  it('эпизод, открытый к концу окна, остаётся без снятия', () => {
    const replay = core();
    for (const frame of series(0, [10, 10, 10, 10, 10, 10, 10])) replay.frame(frame, SOURCE);

    expect(replay.episodes()).toMatchObject([
      { variant: 'patched', clearedAt: null, clearedValue: null },
    ]);
  });

  it('кадры вне окна [from, to) и чужих приборов не участвуют в расчёте', () => {
    const replay = core();

    expect(replay.frame(frameAt(FROM_MS - 1, 10), SOURCE)).toBe('ignored');
    expect(replay.frame(frameAt(TO_MS, 10), SOURCE)).toBe('ignored');
    expect(replay.frame(frameAt(FROM_MS, 10, { deviceCode: OTHER }), SOURCE)).toBe('ignored');
    expect(replay.frame(frameAt(FROM_MS, 10), SOURCE)).toBe('matched');
    expect(replay.frame(frameAt(TO_MS - 1, 10), SOURCE)).toBe('matched');

    expect(replay.counts()).toEqual({
      framesMatched: 2,
      framesRejected: 0,
      coveredFrom: new Date(FROM_MS).toISOString(),
      coveredTo: new Date(TO_MS - 1).toISOString(),
    });
  });

  it('кадр не позже последнего принятого по прибору отвергается и не поднимает эпизод повторно', () => {
    const replay = core();
    for (const frame of series(0, [10, 10, 10, 10, 10, 10])) replay.frame(frame, SOURCE);

    expect(replay.frame(frameAt(FROM_MS + 5 * CYCLE_MS, 10), SOURCE)).toBe('rejected');
    expect(replay.frame(frameAt(FROM_MS + 2 * CYCLE_MS, 6), SOURCE)).toBe('rejected');
    expect(replay.frame(frameAt(FROM_MS + 6 * CYCLE_MS, 10), SOURCE)).toBe('matched');

    expect(replay.counts()).toMatchObject({ framesMatched: 7, framesRejected: 2 });
    expect(replay.episodes()).toMatchObject([{ variant: 'patched', clearedAt: null }]);
  });

  it('кадр, который не разобрал профиль, считается отвергнутым', () => {
    const replay = core();

    expect(replay.frame(frameAt(FROM_MS, 10, { profileVersion: 99 }), SOURCE)).toBe('rejected');
    expect(replay.undecodable(DEVICE)).toBe('rejected');
    expect(replay.undecodable(OTHER)).toBe('ignored');
    expect(replay.undecodable(null)).toBe('ignored');
    expect(replay.counts()).toMatchObject({ framesMatched: 0, framesRejected: 2 });
  });

  it('варианты считаются независимо по каждому выбранному прибору', () => {
    const replay = core({ deviceCodes: [DEVICE, OTHER] });
    for (const frame of series(0, [10, 10, 10, 10, 10, 10])) {
      replay.frame(frame, SOURCE);
      replay.frame({ ...frame, deviceCode: OTHER }, SOURCE);
    }

    expect(
      replay.episodes().map((episode) => `${episode.variant}:${String(episode.deviceId)}`),
    ).toEqual(['patched:1', 'patched:2']);
  });

  it('превышение предела эпизодов даёт понятную ошибку', () => {
    const replay = core({ maxEpisodes: 1 });
    for (const frame of series(0, [10, 10, 10, 10, 10, 10, 6])) replay.frame(frame, SOURCE);

    let thrown: unknown = null;
    try {
      for (const frame of series(7, [10, 10, 10, 10, 10, 10])) replay.frame(frame, SOURCE);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ReplayLimitError);
    expect(String(thrown)).toMatch(/эпизодов в варианте «стало» больше 1/);
  });

  it('снимок уставок разбирается схемой контрактов, неразборчивый даёт понятную ошибку', () => {
    expect(parseReplayRules({ baseline: RULES.baseline, patched: RULES.patched })).toEqual(RULES);
    expect(() =>
      parseReplayRules({ baseline: RULES.baseline, patched: [{ metricKey: 'evap_temp_c' }] }),
    ).toThrow(/снимок уставок «стало» в прогоне не разобран/);
  });
});
