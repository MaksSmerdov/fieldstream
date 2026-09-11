import { describe, expect, it } from 'vitest';
import { simFaultRequestSchema } from '@fieldstream/contracts';
import type { RegisterType, SimFaultRequest, SimFaultRequestInput } from '@fieldstream/contracts';
import {
  DEMO_STAND,
  buildDeviceReadPlan,
  listPlanEntries,
  paramWordsInBlock,
  profileByKey,
} from '@fieldstream/device-profiles';
import { createFakeClock } from '@fieldstream/domain';
import { decodeParam } from '@fieldstream/modbus-codec';
import type { ModbusRequest } from './modbus/frame.js';
import { createSimulator } from './simulator.js';
import type { Simulator } from './simulator.js';

const START = Date.parse('2026-09-11T10:00:00Z');

const makeSim = (): Simulator =>
  createSimulator({
    stand: DEMO_STAND,
    seed: 'sim-test',
    clock: createFakeClock(START),
    speed: 1,
    stallMs: 5000,
  });

const fault = (input: SimFaultRequestInput): SimFaultRequest => simFaultRequestSchema.parse(input);

const read = (
  unitId: number,
  registerType: RegisterType,
  address: number,
  quantity: number,
): ModbusRequest => ({
  kind: 'read',
  transactionId: 1,
  unitId,
  functionCode: registerType === 'holding' ? 3 : 4,
  registerType,
  address,
  quantity,
});

const valuesOf = (sim: Simulator, code: string): Record<string, unknown> =>
  sim.state().devices.find((device) => device.deviceCode === code)?.values ?? {};

describe('стенд', () => {
  it('регистры, прочитанные по плану и разобранные кодеком, совпадают с эталоном по всем приборам', () => {
    const sim = makeSim();
    const mismatches: string[] = [];

    for (const device of DEMO_STAND.devices) {
      const profile = profileByKey(device.profileKey);
      if (profile === undefined) continue;
      const expected = valuesOf(sim, device.code);
      const params = new Map(
        listPlanEntries(profile).map((entry) => [entry.param.key, entry.param]),
      );

      for (const block of buildDeviceReadPlan(profile).blocks) {
        const answer = sim.answer(
          device.lineCode,
          read(device.slaveId, block.registerType, block.startAddress, block.registerCount),
        );
        if (answer.kind !== 'registers') {
          mismatches.push(`${device.code}: ответ ${answer.kind}`);
          continue;
        }

        for (const key of block.paramKeys) {
          const param = params.get(key);
          if (param === undefined) continue;
          const decoded = decodeParam(paramWordsInBlock(block, answer.words, param), param);
          if (JSON.stringify(decoded) !== JSON.stringify(expected[key])) {
            mismatches.push(`${device.code}.${key}: ${JSON.stringify(decoded)}`);
          }
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('на неизвестный адрес линия молчит', () => {
    expect(makeSim().answer('L1', read(9, 'input', 0, 1))).toEqual({ kind: 'silent' });
  });

  it('отвергнутый разбором запрос получает исключение от прибора', () => {
    const answer = makeSim().answer('L1', {
      kind: 'rejected',
      transactionId: 1,
      unitId: 1,
      functionCode: 6,
      exceptionCode: 1,
    });

    expect(answer).toEqual({ kind: 'exception', code: 1, stallMs: 0 });
  });

  it('поломка на линию бьёт по всем её приборам и только по ним', () => {
    const sim = makeSim();
    sim.applyFault(fault({ targetKind: 'line', targetId: 'L2', kind: 'crc' }));

    expect(sim.answer('L2', read(1, 'input', 0, 4))).toMatchObject({ garbled: true });
    expect(sim.answer('L1', read(1, 'input', 0, 4))).toMatchObject({ garbled: false });
  });

  it('зависание добавляет задержку, а молчание перекрывает всё остальное', () => {
    const sim = makeSim();
    sim.applyFault(fault({ targetKind: 'device', targetId: 'RC-101', kind: 'stall' }));
    expect(sim.answer('L1', read(1, 'input', 0, 4))).toMatchObject({ stallMs: 5000 });

    sim.applyFault(fault({ targetKind: 'device', targetId: 'RC-101', kind: 'silent' }));
    expect(sim.answer('L1', read(1, 'input', 0, 4))).toEqual({ kind: 'silent' });
  });

  it('уход за шкалу поднимает значение выше диапазона и бит обрыва датчика', () => {
    const sim = makeSim();
    const result = sim.applyFault(
      fault({ targetKind: 'device', targetId: 'RC-101', kind: 'offscale' }),
    );
    const values = valuesOf(sim, 'RC-101');

    expect(result).toMatchObject({ outcome: 'fault', fault: { paramKey: 'supply_temp_c' } });
    expect(values['supply_temp_c']).toBeGreaterThan(15);
    expect(values['alarm_bits']).toMatchObject({ probe_fault: true });
  });

  it('уход за шкалу для счётчика, перечисления или неизвестного параметра отвергается', () => {
    const sim = makeSim();
    const offscale = (targetId: string, paramKey: string): unknown =>
      sim.applyFault(fault({ targetKind: 'device', targetId, kind: 'offscale', paramKey }));

    expect(offscale('PM-201', 'energy_kwh')).toMatchObject({ outcome: 'rejected', status: 422 });
    expect(offscale('RC-101', 'compressor_state')).toMatchObject({
      outcome: 'rejected',
      status: 422,
    });
    expect(offscale('RC-101', 'nope')).toMatchObject({ outcome: 'rejected', status: 422 });
  });

  it('дверь и оттайка к счётчику неприменимы', () => {
    const sim = makeSim();

    expect(
      sim.applyFault(fault({ targetKind: 'device', targetId: 'PM-201', kind: 'door_stuck' })),
    ).toMatchObject({ outcome: 'rejected', status: 422 });
    expect(
      sim.applyFault(fault({ targetKind: 'device', targetId: 'PM-201', kind: 'defrost' })),
    ).toMatchObject({ outcome: 'rejected', status: 422 });
  });

  it('цель, которой нет на стенде, даёт 404', () => {
    const sim = makeSim();

    expect(
      sim.applyFault(fault({ targetKind: 'device', targetId: 'RC-199', kind: 'silent' })),
    ).toMatchObject({ outcome: 'rejected', status: 404 });
    expect(
      sim.applyFault(fault({ targetKind: 'line', targetId: 'L9', kind: 'silent' })),
    ).toMatchObject({ outcome: 'rejected', status: 404 });
  });

  it('оттайка по команде это действие, а не поломка в журнале', () => {
    const sim = makeSim();
    const result = sim.applyFault(
      fault({ targetKind: 'device', targetId: 'RC-101', kind: 'defrost' }),
    );

    expect(result).toEqual({ outcome: 'action', action: 'defrost_started', deviceCode: 'RC-101' });
    expect(sim.state().faults).toEqual([]);
    expect(valuesOf(sim, 'RC-101')['defrost_state']).toBe('heating');
  });

  it('обрыв шлюза переводит линию в offline', () => {
    const sim = makeSim();
    sim.applyFault(fault({ targetKind: 'line', targetId: 'L3', kind: 'offline' }));

    expect(sim.isLineOnline('L3')).toBe(false);
    expect(sim.isLineOnline('L1')).toBe(true);
    expect(sim.state().lines.find((line) => line.lineCode === 'L3')?.online).toBe(false);
  });

  it('сценарий ночной оттайки запускает оттайку во всех камерах', () => {
    const sim = makeSim();
    const results = sim.runScenario('night-defrost');
    const heating = sim
      .state()
      .devices.filter((device) => device.values['defrost_state'] === 'heating');

    expect(results).toHaveLength(12);
    expect(results.every((result) => result.outcome === 'action')).toBe(true);
    expect(heating).toHaveLength(12);
  });

  it('счётчик запросов линии растёт с каждым обращением', () => {
    const sim = makeSim();
    sim.answer('L1', read(1, 'input', 0, 4));
    sim.answer('L1', read(9, 'input', 0, 4));

    expect(sim.state().lines.find((line) => line.lineCode === 'L1')).toMatchObject({
      requests: 2,
      lastRequestAt: '2026-09-11T10:00:00.000Z',
    });
  });
});
