import type { DecodedValue } from '@fieldstream/modbus-codec';
import type { CompressorState } from './chamber.js';
import { lag } from './lag.js';
import type { Random } from './random.js';

type Phase = 0 | 1 | 2;
type Phases = readonly [number, number, number];

/** Значение для каждой из трёх фаз. */
const byPhase = (value: (phase: Phase) => number): Phases => [value(0), value(1), value(2)];

/** Состояние трёхфазного счётчика на вводе компрессорного агрегата камеры. */
export interface MeterState {
  readonly powerKw: number;
  readonly powerFactor: number;
  readonly energyKwh: number;
  readonly voltagesV: Phases;
  readonly voltageBiasV: Phases;
  readonly currentShare: Phases;
}

/** Нагрузка на шаге: агрегат питает конкретную камеру и повторяет её состояние. */
export interface MeterInputs {
  readonly compressor: CompressorState;
  readonly heating: boolean;
  readonly activity: number;
  readonly hour: number;
  readonly powerDip: boolean;
}

/**
 * Параметры модели. Пусковой ток ограничен так, чтобы скачок за один опрос
 * оставался меньше порога фильтра скачков профиля.
 */
export const METER = Object.freeze({
  baseKw: 1.5,
  shiftKw: 1.5,
  heaterKw: 7,
  basePf: 0.93,
  heaterPf: 0.99,
  nominalV: 230,
  eveningSagV: 3,
  dropVPerKw: 0.08,
  dipFactor: 0.82,
  powerTauSec: 4,
  voltageTauSec: 2,
});

const COMPRESSOR_KW: Readonly<Record<CompressorState, number>> = Object.freeze({
  stopped: 0,
  starting: 14,
  running: 11,
  unloading: 6,
});

const COMPRESSOR_PF: Readonly<Record<CompressorState, number>> = Object.freeze({
  stopped: 0.9,
  starting: 0.72,
  running: 0.82,
  unloading: 0.78,
});

/** Один шаг счётчика: мощность идёт за нагрузкой, энергия копится, напряжение проседает под током. */
export const stepMeter = (state: MeterState, inputs: MeterInputs, dtSec: number): MeterState => {
  const baseKw = METER.baseKw + METER.shiftKw * inputs.activity;
  const compressorKw = COMPRESSOR_KW[inputs.compressor];
  const heaterKw = inputs.heating ? METER.heaterKw : 0;
  const targetKw = baseKw + compressorKw + heaterKw;
  const targetPf =
    (baseKw * METER.basePf +
      compressorKw * COMPRESSOR_PF[inputs.compressor] +
      heaterKw * METER.heaterPf) /
    targetKw;
  const powerKw = lag(state.powerKw, targetKw, dtSec, METER.powerTauSec);
  const gridV =
    METER.nominalV - METER.eveningSagV * Math.cos(((inputs.hour - 19) / 24) * 2 * Math.PI);
  const dip = inputs.powerDip ? METER.dipFactor : 1;

  return {
    ...state,
    powerKw,
    powerFactor: lag(state.powerFactor, targetPf, dtSec, METER.powerTauSec),
    energyKwh: state.energyKwh + (powerKw * dtSec) / 3600,
    voltagesV: byPhase((phase) =>
      lag(
        state.voltagesV[phase],
        (gridV + state.voltageBiasV[phase] - METER.dropVPerKw * powerKw) * dip,
        dtSec,
        METER.voltageTauSec,
      ),
    ),
  };
};

/** Начальное состояние: у каждого счётчика своё показание энергии и свой перекос фаз. */
export const initialMeter = (random: Random): MeterState => {
  const voltageBiasV = byPhase(() => (random.next() - 0.5) * 4);

  return {
    powerKw: METER.baseKw,
    powerFactor: METER.basePf,
    energyKwh: 10_000 + Math.floor(random.next() * 40_000),
    voltagesV: byPhase((phase) => METER.nominalV + voltageBiasV[phase]),
    voltageBiasV,
    currentShare: byPhase(() => 0.97 + random.next() * 0.06),
  };
};

/** Показания счётчика в ключах профиля pm-3phase. Ток фазы выводится из P = 3·U·I·cosφ. */
export const meterValues = (state: MeterState): Map<string, DecodedValue> => {
  const current = (phase: Phase): number =>
    (state.powerKw * 1000 * state.currentShare[phase]) /
    (3 * state.voltagesV[phase] * state.powerFactor);

  return new Map<string, DecodedValue>([
    ['voltage_l1_v', state.voltagesV[0]],
    ['voltage_l2_v', state.voltagesV[1]],
    ['voltage_l3_v', state.voltagesV[2]],
    ['current_l1_a', current(0)],
    ['current_l2_a', current(1)],
    ['current_l3_a', current(2)],
    ['active_power_kw', state.powerKw],
    ['power_factor', state.powerFactor],
    ['energy_kwh', state.energyKwh],
  ]);
};
