import { simFaultRequestSchema } from '@fieldstream/contracts';
import type {
  DeviceProfile,
  ParamSpec,
  SimFault,
  SimFaultRequest,
  SimScenarioName,
  SimState,
  Stand,
  StandDevice,
} from '@fieldstream/contracts';
import {
  encodeSimulationRegisters,
  listPlanEntries,
  profileByKey,
  readSimulatedBlock,
} from '@fieldstream/device-profiles';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import type { DecodedValue } from '@fieldstream/modbus-codec';
import { createFaultBook } from './chaos/faults.js';
import type { ActiveFault } from './chaos/faults.js';
import { SCENARIOS } from './chaos/scenarios.js';
import { MODBUS_EXCEPTION } from './modbus/frame.js';
import type { Answer, ModbusRequest } from './modbus/frame.js';
import { createWorld } from './physics/world.js';

export interface SimulatorOptions {
  readonly stand: Stand;
  readonly seed: string;
  readonly clock: Clock;
  readonly speed: number;
  readonly stallMs: number;
}

export type FaultResult =
  | { readonly outcome: 'fault'; readonly fault: SimFault }
  | { readonly outcome: 'action'; readonly action: 'defrost_started'; readonly deviceCode: string }
  | { readonly outcome: 'rejected'; readonly status: 404 | 422; readonly message: string };

/** Стенд целиком: мир с физикой, журнал поломок и ответы на запросы с линий. */
export interface Simulator {
  readonly stand: Stand;
  readonly answer: (lineCode: string, request: ModbusRequest) => Answer;
  readonly isLineOnline: (lineCode: string) => boolean;
  readonly applyFault: (request: SimFaultRequest) => FaultResult;
  readonly clearFaults: () => number;
  readonly runScenario: (name: SimScenarioName) => FaultResult[];
  readonly setSpeed: (factor: number) => void;
  readonly state: () => SimState;
}

interface LineStats {
  requests: number;
  lastRequestMs: number | null;
}

type OffscaleTarget = { readonly param: ParamSpec } | { readonly error: string };

const SILENT: Answer = Object.freeze({ kind: 'silent' });

const rejected = (status: 404 | 422, message: string): FaultResult => ({
  outcome: 'rejected',
  status,
  message,
});

/** Измеряемая величина с диапазоном: только её можно увести за шкалу. */
const canGoOffscale = (param: ParamSpec): boolean =>
  param.range !== undefined &&
  !param.range.monotonic &&
  param.enum === undefined &&
  param.bits === undefined;

/** Значение заведомо за шкалой: на два диапазона выше верхней границы. */
const offscaleValue = (param: ParamSpec): number =>
  param.range === undefined ? 0 : param.range.max + (param.range.max - param.range.min) * 2;

/** Параметр для ухода за шкалу: указанный явно или первый измеряемый во входных регистрах. */
const resolveOffscale = (profile: DeviceProfile, paramKey: string | undefined): OffscaleTarget => {
  const params = listPlanEntries(profile).map((entry) => entry.param);

  if (paramKey !== undefined) {
    const param = params.find((candidate) => candidate.key === paramKey);
    if (param === undefined)
      return { error: `у модели ${profile.profileKey} нет параметра "${paramKey}"` };
    return canGoOffscale(param)
      ? { param }
      : { error: `параметр "${paramKey}" не измеряемая величина с диапазоном` };
  }

  const param =
    params.find((candidate) => candidate.registerType === 'input' && canGoOffscale(candidate)) ??
    params.find(canGoOffscale);
  return param === undefined
    ? { error: `у модели ${profile.profileKey} нет измеряемых параметров с диапазоном` }
    : { param };
};

const toContract = (fault: ActiveFault): SimFault => ({
  id: fault.id,
  targetKind: fault.targetKind,
  targetId: fault.targetId,
  kind: fault.kind,
  since: toIsoTimestamp(fault.sinceMs),
  expiresAt: toIsoTimestamp(fault.expiresAtMs),
  exceptionCode: fault.exceptionCode,
  paramKey: fault.paramKey,
});

/** Собирает стенд из описания: мир, журнал поломок и адресацию приборов по линиям. */
export const createSimulator = (options: SimulatorOptions): Simulator => {
  const { stand, clock } = options;
  const book = createFaultBook(clock);
  const world = createWorld({
    stand,
    seed: options.seed,
    clock,
    speed: options.speed,
    faults: {
      doorStuck: (deviceCode) => book.onDevice(deviceCode, 'door_stuck'),
      powerDip: (lineCode) => book.onLine(lineCode, 'power_dip'),
    },
  });

  const devices = new Map(stand.devices.map((device) => [device.code, device]));
  const byAddress = new Map(
    stand.devices.map((device) => [`${device.lineCode}:${String(device.slaveId)}`, device]),
  );
  const lineStats = new Map<string, LineStats>(
    stand.lines.map((line) => [line.code, { requests: 0, lastRequestMs: null }]),
  );

  const profileOf = (device: StandDevice): DeviceProfile => {
    const profile = profileByKey(device.profileKey);
    if (profile === undefined) {
      throw new Error(`прибор ${device.code}: неизвестная модель ${device.profileKey}`);
    }
    return profile;
  };

  /** Показания прибора с учётом поломок, которые меняют сами значения. */
  const deviceValues = (device: StandDevice): Map<string, DecodedValue> => {
    const values = world.values(device.code) ?? new Map<string, DecodedValue>();
    const offscale = book
      .affecting(device.lineCode, device.code)
      .find((fault) => fault.kind === 'offscale');
    if (offscale === undefined || offscale.paramKey === null) return values;

    const param = listPlanEntries(profileOf(device)).find(
      (entry) => entry.param.key === offscale.paramKey,
    )?.param;
    if (param !== undefined) values.set(param.key, offscaleValue(param));

    for (const [key, value] of values) {
      if (value !== null && typeof value === 'object' && 'probe_fault' in value) {
        values.set(key, { ...value, probe_fault: true });
      }
    }
    return values;
  };

  const isLineOnline = (lineCode: string): boolean => !book.onLine(lineCode, 'offline');

  const answer = (lineCode: string, request: ModbusRequest): Answer => {
    const stats = lineStats.get(lineCode);
    if (stats !== undefined) {
      stats.requests += 1;
      stats.lastRequestMs = clock.now();
    }

    const device = byAddress.get(`${lineCode}:${String(request.unitId)}`);
    if (device === undefined) return SILENT;

    const faults = book.affecting(lineCode, device.code);
    const has = (kind: ActiveFault['kind']): ActiveFault | undefined =>
      faults.find((fault) => fault.kind === kind);
    if (has('silent') !== undefined) return SILENT;

    const stallMs = has('stall') === undefined ? 0 : options.stallMs;
    if (request.kind === 'rejected') {
      return { kind: 'exception', code: request.exceptionCode, stallMs };
    }

    const exception = has('exception');
    if (exception !== undefined) {
      return {
        kind: 'exception',
        code: exception.exceptionCode ?? MODBUS_EXCEPTION.deviceFailure,
        stallMs,
      };
    }

    const registers = encodeSimulationRegisters(profileOf(device), deviceValues(device));
    const words = readSimulatedBlock(registers, {
      registerType: request.registerType,
      startAddress: request.address,
      registerCount: request.quantity,
    });
    return { kind: 'registers', words, garbled: has('crc') !== undefined, stallMs };
  };

  const applyFault = (request: SimFaultRequest): FaultResult => {
    if (request.targetKind === 'line') {
      if (!lineStats.has(request.targetId)) {
        return rejected(404, `линии ${request.targetId} на стенде нет`);
      }
      return { outcome: 'fault', fault: toContract(book.add(request, null)) };
    }

    const device = devices.get(request.targetId);
    if (device === undefined) return rejected(404, `прибора ${request.targetId} на стенде нет`);

    if (
      (request.kind === 'door_stuck' || request.kind === 'defrost') &&
      !world.isChamber(device.code)
    ) {
      return rejected(
        422,
        `${device.code} не камера: поломка "${request.kind}" к нему неприменима`,
      );
    }

    if (request.kind === 'defrost') {
      world.startDefrost(device.code);
      return { outcome: 'action', action: 'defrost_started', deviceCode: device.code };
    }

    if (request.kind === 'offscale') {
      const target = resolveOffscale(profileOf(device), request.paramKey);
      if ('error' in target) return rejected(422, target.error);
      return { outcome: 'fault', fault: toContract(book.add(request, target.param.key)) };
    }

    return { outcome: 'fault', fault: toContract(book.add(request, null)) };
  };

  const state = (): SimState => ({
    simTime: toIsoTimestamp(world.simNow()),
    speed: world.speed(),
    seed: options.seed,
    lines: stand.lines.map((line) => {
      const stats = lineStats.get(line.code);
      const lastRequestMs = stats?.lastRequestMs ?? null;
      return {
        lineCode: line.code,
        port: line.port,
        baud: line.baud,
        online: isLineOnline(line.code),
        requests: stats?.requests ?? 0,
        lastRequestAt: lastRequestMs === null ? null : toIsoTimestamp(lastRequestMs),
      };
    }),
    devices: stand.devices.map((device) => ({
      deviceCode: device.code,
      lineCode: device.lineCode,
      slaveId: device.slaveId,
      profileKey: device.profileKey,
      values: Object.fromEntries(deviceValues(device)),
      faults: [...new Set(book.affecting(device.lineCode, device.code).map((fault) => fault.kind))],
    })),
    faults: book.list().map(toContract),
  });

  return {
    stand,
    answer,
    isLineOnline,
    applyFault,
    clearFaults: () => book.clear(),
    runScenario: (name) =>
      SCENARIOS[name](stand).map((input) => {
        const parsed = simFaultRequestSchema.safeParse(input);
        return parsed.success ? applyFault(parsed.data) : rejected(422, parsed.error.message);
      }),
    setSpeed: (factor) => {
      world.setSpeed(factor);
    },
    state,
  };
};
