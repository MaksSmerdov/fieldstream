import { deviceCodeSchema } from '@fieldstream/contracts';
import type { DeviceCode, DeviceProfile } from '@fieldstream/contracts';
import { defineDeviceProfile } from '../validate.js';

/** Приборы, которые обслуживает профиль: трёхфазные счётчики на вводах. */
export const PM3PHASE_DEVICE_CODES: readonly DeviceCode[] = Array.from({ length: 12 }, (_, index) =>
  deviceCodeSchema.parse(`PM-${String(201 + index)}`),
);

/**
 * Счётчик электроэнергии PM-3Phase.
 * Порядок байт у параметров разный, как у настоящего прибора: у счётчика энергии CDAB,
 * у токов DCBA, у мощности BADC. Блоки объявлены руками: производитель разрешает читать
 * дыру на адресе 3 одним запросом, автосборка при maxGap = 0 так не умеет.
 */
export const pm3PhaseProfile: DeviceProfile = defineDeviceProfile({
  profileKey: 'pm-3phase',
  version: 1,
  label: 'Счётчик электроэнергии PM-3Phase',
  readPlan: {
    blocks: [
      { id: 'mains', registerType: 'input', startAddress: 0, registerCount: 10 },
      { id: 'power', registerType: 'input', startAddress: 16, registerCount: 3 },
      { id: 'energy', registerType: 'input', startAddress: 32, registerCount: 2 },
    ],
  },
  sections: [
    {
      key: 'voltage',
      label: 'Напряжения',
      params: [
        {
          key: 'voltage_l1_v',
          label: 'Напряжение L1',
          unit: 'В',
          address: 0,
          registerType: 'input',
          dataType: 'uint16',
          scale: 0.1,
          precision: 1,
          range: { min: 200, max: 250 },
          maxDelta: 30,
        },
        {
          key: 'voltage_l2_v',
          label: 'Напряжение L2',
          unit: 'В',
          address: 1,
          registerType: 'input',
          dataType: 'uint16',
          scale: 0.1,
          precision: 1,
          range: { min: 200, max: 250 },
          maxDelta: 30,
        },
        {
          key: 'voltage_l3_v',
          label: 'Напряжение L3',
          unit: 'В',
          address: 2,
          registerType: 'input',
          dataType: 'uint16',
          scale: 0.1,
          precision: 1,
          range: { min: 200, max: 250 },
          maxDelta: 30,
        },
      ],
    },
    {
      key: 'current',
      label: 'Токи',
      params: [
        {
          key: 'current_l1_a',
          label: 'Ток L1',
          unit: 'А',
          address: 4,
          registerType: 'input',
          dataType: 'float32',
          byteOrder: 'DCBA',
          precision: 2,
          range: { min: 0, max: 80 },
          maxDelta: 40,
        },
        {
          key: 'current_l2_a',
          label: 'Ток L2',
          unit: 'А',
          address: 6,
          registerType: 'input',
          dataType: 'float32',
          byteOrder: 'DCBA',
          precision: 2,
          range: { min: 0, max: 80 },
          maxDelta: 40,
        },
        {
          key: 'current_l3_a',
          label: 'Ток L3',
          unit: 'А',
          address: 8,
          registerType: 'input',
          dataType: 'float32',
          byteOrder: 'DCBA',
          precision: 2,
          range: { min: 0, max: 80 },
          maxDelta: 40,
        },
      ],
    },
    {
      key: 'power',
      label: 'Мощность',
      params: [
        {
          key: 'active_power_kw',
          label: 'Активная мощность',
          unit: 'кВт',
          address: 16,
          registerType: 'input',
          dataType: 'float32',
          byteOrder: 'BADC',
          precision: 2,
          range: { min: 0, max: 55 },
          maxDelta: 30,
        },
        {
          key: 'power_factor',
          label: 'Коэффициент мощности',
          address: 18,
          registerType: 'input',
          dataType: 'int16',
          scale: 0.001,
          precision: 3,
          range: { min: 0.6, max: 1 },
          maxDelta: 0.4,
        },
      ],
    },
    {
      key: 'energy',
      label: 'Энергия',
      params: [
        {
          key: 'energy_kwh',
          label: 'Активная энергия',
          unit: 'кВт·ч',
          address: 32,
          registerType: 'input',
          dataType: 'uint32',
          byteOrder: 'CDAB',
          scale: 0.1,
          precision: 1,
          range: { min: 0, max: 500000, monotonic: true },
          maxDelta: 50,
        },
      ],
    },
  ],
});
