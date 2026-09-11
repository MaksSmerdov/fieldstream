import { describe, expect, it } from 'vitest';
import { telemetryReadingSchema } from '@fieldstream/contracts';
import type { DeviceProfile, RawBlock, TelemetryRaw } from '@fieldstream/contracts';
import { QUALITY_CODE } from '@fieldstream/db';
import type { DeviceRef } from '@fieldstream/db';
import {
  buildDeviceReadPlan,
  buildSimulationValues,
  encodeSimulationRegisters,
  rc2000Profile,
  readSimulatedBlock,
} from '@fieldstream/device-profiles';
import type { SpikeFilterState } from '@fieldstream/domain';
import type { DecodedValue } from '@fieldstream/modbus-codec';
import { filterKey, processFrame } from './frame.js';
import type { FrameOutcome } from './frame.js';

const REFS = new Map<string, DeviceRef>([
  ['RC-101', { deviceId: 1, lineId: 1, code: 'RC-101', lineCode: 'L1' }],
]);
const SOURCE = { partition: 2, offset: '184' };

/** Блоки кадра, прочитанные по плану из регистров с заданными значениями. */
const blocksOf = (
  profile: DeviceProfile,
  values: ReadonlyMap<string, DecodedValue>,
): RawBlock[] => {
  const registers = encodeSimulationRegisters(profile, values);
  return buildDeviceReadPlan(profile).blocks.map((block) => ({
    registerType: block.registerType,
    startAddress: block.startAddress,
    words: readSimulatedBlock(registers, block),
  }));
};

/** Показания камеры: правдоподобные значения с точечными подменами. */
const chamber = (overrides: Record<string, DecodedValue> = {}): Map<string, DecodedValue> =>
  new Map([...buildSimulationValues(rc2000Profile, 5), ...Object.entries(overrides)]);

const frame = (
  values: ReadonlyMap<string, DecodedValue>,
  patch: Partial<TelemetryRaw> = {},
): TelemetryRaw => ({
  schema: 'telemetry.raw',
  v: 1,
  ts: '2026-09-11T10:00:00.000Z',
  siteCode: 'SITE-A',
  gatewayCode: 'GW-01',
  lineCode: 'L1',
  deviceCode: 'RC-101',
  slaveId: 1,
  profileKey: rc2000Profile.profileKey,
  profileVersion: rc2000Profile.version,
  blocks: blocksOf(rc2000Profile, values),
  cycleMs: 40,
  traceId: '0123456789abcdef',
  ...patch,
});

const accepted = (outcome: FrameOutcome): Extract<FrameOutcome, { kind: 'accepted' }> => {
  if (outcome.kind !== 'accepted') throw new Error(`кадр отвергнут: ${outcome.error}`);
  return outcome;
};

const run = (
  raw: TelemetryRaw,
  filters: ReadonlyMap<string, SpikeFilterState> = new Map(),
): FrameOutcome => processFrame(raw, { refs: REFS, filters, source: SOURCE });

describe('обработка сырого кадра', () => {
  it('даёт строку на каждый параметр и показание по контракту топика', () => {
    const outcome = accepted(
      run(frame(chamber({ compressor_state: 'running', defrost_state: 'idle' }))),
    );

    expect(outcome.rows).toHaveLength(9);
    expect(outcome.rows.every((row) => row.deviceId === 1 && row.quality === QUALITY_CODE.ok)).toBe(
      true,
    );
    expect(outcome.rows.find((row) => row.metricKey === 'compressor_state')?.value).toBe(2);
    expect(telemetryReadingSchema.safeParse(outcome.reading).success).toBe(true);
    expect(outcome.reading).toMatchObject({ mode: 'cooling', quality: 'ok', sourceOffset: SOURCE });
  });

  it('оттайка переводит камеру в режим defrost, дверь и оттайка видны в наблюдении', () => {
    const outcome = accepted(run(frame(chamber({ defrost_state: 'heating', door_open: 'open' }))));

    expect(outcome.observation).toEqual({
      deviceCode: 'RC-101',
      atMs: Date.parse('2026-09-11T10:00:00.000Z'),
      mode: 'defrost',
      doorOpen: true,
      defrostActive: true,
    });
  });

  it('неизвестный прибор и неизвестная версия профиля отвергаются со своим классом', () => {
    expect(run(frame(chamber(), { deviceCode: 'RC-199' }))).toMatchObject({
      kind: 'rejected',
      errorClass: 'unknown_device',
    });
    expect(run(frame(chamber(), { profileVersion: 2 }))).toMatchObject({
      kind: 'rejected',
      errorClass: 'unknown_profile_version',
    });
  });

  it('скачок заменяется последним принятым значением, пока новый уровень не подтвердится трижды', () => {
    let filters: ReadonlyMap<string, SpikeFilterState> = new Map();
    const supply = (value: number): { value: number | null; quality: number } => {
      const outcome = accepted(run(frame(chamber({ supply_temp_c: value })), filters));
      filters = new Map([...filters, ...outcome.filters]);
      const row = outcome.rows.find((candidate) => candidate.metricKey === 'supply_temp_c');
      return { value: row?.value ?? null, quality: row?.quality ?? -1 };
    };

    expect(supply(-18)).toEqual({ value: -18, quality: QUALITY_CODE.ok });
    expect(supply(-5)).toEqual({ value: -18, quality: QUALITY_CODE.substituted });
    expect(supply(-5)).toEqual({ value: -18, quality: QUALITY_CODE.substituted });
    expect(supply(-5)).toEqual({ value: -5, quality: QUALITY_CODE.ok });
  });

  it('функция чистая: переданная память фильтров не меняется', () => {
    const filters = new Map<string, SpikeFilterState>([
      [
        filterKey('RC-101', 'supply_temp_c'),
        { accepted: -18, candidate: null, candidateCycles: 0 },
      ],
    ]);
    const before = JSON.stringify([...filters]);

    const outcome = accepted(run(frame(chamber({ supply_temp_c: 3 })), filters));

    expect(JSON.stringify([...filters])).toBe(before);
    expect(outcome.reading.quality).toBe('substituted');
  });
});
