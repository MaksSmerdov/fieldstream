import type { DecodedValue } from '@fieldstream/modbus-codec';
import { lag } from './lag.js';
import type { Random } from './random.js';

export type CompressorState = 'stopped' | 'starting' | 'running' | 'unloading';
export type DefrostState = 'idle' | 'heating' | 'draining';

/** Состояние камеры, которой управляет холодильный контроллер. */
export interface ChamberState {
  readonly airC: number;
  readonly supplyC: number;
  readonly returnC: number;
  readonly evapC: number;
  readonly superheatK: number;
  readonly setpointC: number;
  readonly compressor: CompressorState;
  readonly compressorSec: number;
  readonly defrost: DefrostState;
  readonly defrostSec: number;
  readonly nextDefrostSec: number;
  readonly doorOpen: boolean;
  readonly doorOpenSec: number;
  readonly doorCloseAfterSec: number;
  readonly warmSec: number;
}

/** Внешние условия шага: помещение, смена и внесённые поломки. */
export interface ChamberInputs {
  readonly ambientC: number;
  readonly activity: number;
  readonly doorStuck: boolean;
  readonly powerDip: boolean;
}

/**
 * Параметры модели. Подобраны так, чтобы цикл компрессора занимал минуты,
 * оттайка поднимала воздух на 6-7 градусов, а открытая дверь была заметна на графике.
 */
export const CHAMBER = Object.freeze({
  hysteresisK: 1,
  leakPerSec: 1 / 10_800,
  doorPerSec: 1 / 2_400,
  coolingKPerSec: 0.012,
  defrostHeatKPerSec: 0.006,
  defrostCoilC: 10,
  evapOffsetK: 8,
  evapTauSec: 60,
  coilHeatTauSec: 150,
  supplyMix: 0.25,
  returnOffsetK: 0.8,
  superheatK: 6,
  idleSuperheatK: 12,
  startingSec: 10,
  unloadingSec: 15,
  minOffSec: 180,
  defrostIntervalSec: 40 * 60,
  heatingSec: 12 * 60,
  drainingSec: 3 * 60,
  nightDoorPerSec: 1 / 14_400,
  shiftDoorPerSec: 1 / 1_800,
  doorMinSec: 20,
  doorSpreadSec: 70,
  highTempMarginK: 6,
  highTempDelaySec: 600,
  lowTempMarginK: 5,
  doorAlarmSec: 180,
});

const COOLING_SHARE: Readonly<Record<CompressorState, number>> = Object.freeze({
  stopped: 0,
  starting: 0.3,
  running: 1,
  unloading: 0.5,
});

type CompressorPart = Pick<ChamberState, 'compressor' | 'compressorSec'>;
type DefrostPart = Pick<ChamberState, 'defrost' | 'defrostSec' | 'nextDefrostSec'>;
type DoorPart = Pick<ChamberState, 'doorOpen' | 'doorOpenSec' | 'doorCloseAfterSec'>;

const DOOR_CLOSED: DoorPart = Object.freeze({
  doorOpen: false,
  doorOpenSec: 0,
  doorCloseAfterSec: 0,
});

/** Дверь открывается случайно, чаще в разгар смены, и стоит открытой от 20 до 90 секунд. */
const nextDoor = (
  state: ChamberState,
  inputs: ChamberInputs,
  dtSec: number,
  random: Random,
): DoorPart => {
  if (inputs.doorStuck) {
    return {
      doorOpen: true,
      doorOpenSec: state.doorOpen ? state.doorOpenSec + dtSec : 0,
      doorCloseAfterSec: 0,
    };
  }

  if (state.doorOpen) {
    const left = state.doorCloseAfterSec - dtSec;
    return left > 0
      ? { doorOpen: true, doorOpenSec: state.doorOpenSec + dtSec, doorCloseAfterSec: left }
      : DOOR_CLOSED;
  }

  const openingsPerSec = CHAMBER.nightDoorPerSec + inputs.activity * CHAMBER.shiftDoorPerSec;
  if (random.next() >= openingsPerSec * dtSec) return DOOR_CLOSED;

  return {
    doorOpen: true,
    doorOpenSec: 0,
    doorCloseAfterSec: CHAMBER.doorMinSec + random.next() * CHAMBER.doorSpreadSec,
  };
};

/** Оттайка по расписанию: нагрев, стекание воды, затем снова охлаждение. */
const nextDefrost = (state: ChamberState, dtSec: number): DefrostPart => {
  const sec = state.defrostSec + dtSec;

  switch (state.defrost) {
    case 'idle': {
      const left = state.nextDefrostSec - dtSec;
      return left > 0
        ? { defrost: 'idle', defrostSec: sec, nextDefrostSec: left }
        : { defrost: 'heating', defrostSec: 0, nextDefrostSec: CHAMBER.defrostIntervalSec };
    }
    case 'heating':
      return sec >= CHAMBER.heatingSec
        ? { defrost: 'draining', defrostSec: 0, nextDefrostSec: state.nextDefrostSec }
        : { defrost: 'heating', defrostSec: sec, nextDefrostSec: state.nextDefrostSec };
    case 'draining':
      return sec >= CHAMBER.drainingSec
        ? { defrost: 'idle', defrostSec: 0, nextDefrostSec: state.nextDefrostSec }
        : { defrost: 'draining', defrostSec: sec, nextDefrostSec: state.nextDefrostSec };
  }
};

/** Компрессор с гистерезисом и защитой от частых пусков; провал напряжения выбивает его сразу. */
const nextCompressor = (
  state: ChamberState,
  defrost: DefrostState,
  powerDip: boolean,
  dtSec: number,
): CompressorPart => {
  const sec = state.compressorSec + dtSec;

  if (powerDip) {
    return { compressor: 'stopped', compressorSec: state.compressor === 'stopped' ? sec : 0 };
  }

  const allowed = defrost === 'idle';
  const warm = state.airC > state.setpointC + CHAMBER.hysteresisK;
  const cold = state.airC < state.setpointC - CHAMBER.hysteresisK;

  switch (state.compressor) {
    case 'stopped':
      return allowed && warm && sec >= CHAMBER.minOffSec
        ? { compressor: 'starting', compressorSec: 0 }
        : { compressor: 'stopped', compressorSec: sec };
    case 'starting':
      if (!allowed) return { compressor: 'stopped', compressorSec: 0 };
      return sec >= CHAMBER.startingSec
        ? { compressor: 'running', compressorSec: 0 }
        : { compressor: 'starting', compressorSec: sec };
    case 'running':
      return !allowed || cold
        ? { compressor: 'unloading', compressorSec: 0 }
        : { compressor: 'running', compressorSec: sec };
    case 'unloading':
      return sec >= CHAMBER.unloadingSec
        ? { compressor: 'stopped', compressorSec: 0 }
        : { compressor: 'unloading', compressorSec: sec };
  }
};

/** Один шаг модели камеры длиной dtSec: теплоприток, холод компрессора, нагрев оттайки. */
export const stepChamber = (
  state: ChamberState,
  inputs: ChamberInputs,
  dtSec: number,
  random: Random,
): ChamberState => {
  const door = nextDoor(state, inputs, dtSec, random);
  const defrost = nextDefrost(state, dtSec);
  const compressor = nextCompressor(state, defrost.defrost, inputs.powerDip, dtSec);
  const cooling = COOLING_SHARE[compressor.compressor];
  const heating = defrost.defrost === 'heating';
  const toAmbient = inputs.ambientC - state.airC;

  const airC =
    state.airC +
    dtSec *
      (toAmbient * CHAMBER.leakPerSec +
        (door.doorOpen ? toAmbient * CHAMBER.doorPerSec : 0) -
        cooling * CHAMBER.coolingKPerSec +
        (heating ? CHAMBER.defrostHeatKPerSec : 0));
  const evapC = heating
    ? lag(state.evapC, CHAMBER.defrostCoilC, dtSec, CHAMBER.coilHeatTauSec)
    : lag(state.evapC, airC - CHAMBER.evapOffsetK * cooling, dtSec, CHAMBER.evapTauSec);
  const superheatTarget =
    cooling > 0 ? CHAMBER.superheatK + (random.next() - 0.5) * 2 : CHAMBER.idleSuperheatK;

  return {
    ...door,
    ...defrost,
    ...compressor,
    airC,
    evapC,
    supplyC: lag(state.supplyC, airC + (evapC - airC) * CHAMBER.supplyMix, dtSec, 30),
    returnC: lag(state.returnC, airC + CHAMBER.returnOffsetK, dtSec, 30),
    superheatK: lag(state.superheatK, superheatTarget, dtSec, 45),
    setpointC: state.setpointC,
    warmSec:
      defrost.defrost === 'idle' && airC > state.setpointC + CHAMBER.highTempMarginK
        ? state.warmSec + dtSec
        : 0,
  };
};

/** Оттайка по команде: так её запускают с панели контроллера. */
export const startDefrost = (state: ChamberState): ChamberState =>
  state.defrost === 'idle'
    ? { ...state, defrost: 'heating', defrostSec: 0, nextDefrostSec: CHAMBER.defrostIntervalSec }
    : state;

/** Начальное состояние: у каждой камеры своя уставка и своя фаза расписания оттайки. */
export const initialChamber = (random: Random): ChamberState => {
  const setpointC = -18 + Math.round((random.next() - 0.5) * 4);
  const airC = setpointC + (random.next() - 0.5) * 2 * CHAMBER.hysteresisK;

  return {
    airC,
    supplyC: airC,
    returnC: airC + CHAMBER.returnOffsetK,
    evapC: airC,
    superheatK: CHAMBER.idleSuperheatK,
    setpointC,
    compressor: 'stopped',
    compressorSec: CHAMBER.minOffSec,
    defrost: 'idle',
    defrostSec: 0,
    nextDefrostSec: random.next() * CHAMBER.defrostIntervalSec,
    doorOpen: false,
    doorOpenSec: 0,
    doorCloseAfterSec: 0,
    warmSec: 0,
  };
};

/** Показания контроллера в ключах профиля rc-2000. */
export const chamberValues = (state: ChamberState): Map<string, DecodedValue> =>
  new Map<string, DecodedValue>([
    ['supply_temp_c', state.supplyC],
    ['return_temp_c', state.returnC],
    ['evap_temp_c', state.evapC],
    ['superheat_k', state.superheatK],
    ['setpoint_c', state.setpointC],
    ['compressor_state', state.compressor],
    ['defrost_state', state.defrost],
    ['door_open', state.doorOpen ? 'open' : 'closed'],
    [
      'alarm_bits',
      {
        high_temp: state.warmSec >= CHAMBER.highTempDelaySec,
        low_temp: state.airC < state.setpointC - CHAMBER.lowTempMarginK,
        probe_fault: false,
        hp_switch: false,
        lp_switch: false,
        door_alarm: state.doorOpenSec >= CHAMBER.doorAlarmSec,
        defrost_timeout: false,
        panel_link_ok: true,
      },
    ],
  ]);
