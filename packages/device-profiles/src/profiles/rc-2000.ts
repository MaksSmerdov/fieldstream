import { deviceCodeSchema } from '@fieldstream/contracts';
import type { DeviceCode, DeviceProfile } from '@fieldstream/contracts';
import { defineDeviceProfile } from '../validate.js';

/** Приборы, которые обслуживает профиль: холодильные контроллеры камер. */
export const RC2000_DEVICE_CODES: readonly DeviceCode[] = Array.from({ length: 12 }, (_, index) =>
  deviceCodeSchema.parse(`RC-${String(101 + index)}`),
);

/**
 * Холодильный контроллер RC-2000.
 * Измерения лежат во входных регистрах, уставка в holding: её пишут, а не только читают.
 * Адреса намеренно с разрывами (4..15 и 19..31 пусты), поэтому автосборка при maxGap = 0
 * даёт четыре блока и ни одного лишнего регистра.
 */
export const rc2000Profile: DeviceProfile = defineDeviceProfile({
  profileKey: 'rc-2000',
  version: 1,
  label: 'Холодильный контроллер RC-2000',
  sections: [
    {
      key: 'temps',
      label: 'Температуры',
      params: [
        {
          key: 'supply_temp_c',
          label: 'Температура подачи',
          unit: '°C',
          address: 0,
          registerType: 'input',
          dataType: 'int16',
          scale: 0.1,
          precision: 1,
          range: { min: -30, max: 15 },
          maxDelta: 5,
        },
        {
          key: 'return_temp_c',
          label: 'Температура обратки',
          unit: '°C',
          address: 1,
          registerType: 'input',
          dataType: 'int16',
          scale: 0.1,
          precision: 1,
          range: { min: -28, max: 15 },
          maxDelta: 5,
        },
        {
          key: 'evap_temp_c',
          label: 'Температура испарителя',
          unit: '°C',
          address: 2,
          registerType: 'input',
          dataType: 'int16',
          scale: 0.1,
          precision: 1,
          range: { min: -30, max: 10 },
          maxDelta: 5,
        },
        {
          key: 'superheat_k',
          label: 'Перегрев',
          unit: 'K',
          address: 3,
          registerType: 'input',
          dataType: 'int16',
          scale: 0.1,
          precision: 1,
          range: { min: 0, max: 20 },
          maxDelta: 10,
        },
      ],
    },
    {
      key: 'setpoints',
      label: 'Уставки',
      params: [
        {
          key: 'setpoint_c',
          label: 'Уставка температуры',
          unit: '°C',
          address: 0,
          registerType: 'holding',
          dataType: 'int16',
          scale: 0.1,
          precision: 1,
          range: { min: -25, max: -15 },
          maxDelta: 5,
        },
      ],
    },
    {
      key: 'states',
      label: 'Состояния',
      params: [
        {
          key: 'compressor_state',
          label: 'Состояние компрессора',
          address: 16,
          registerType: 'input',
          dataType: 'uint16',
          precision: 0,
          enum: { '0': 'stopped', '1': 'starting', '2': 'running', '3': 'unloading' },
        },
        {
          key: 'defrost_state',
          label: 'Состояние оттайки',
          address: 17,
          registerType: 'input',
          dataType: 'uint16',
          precision: 0,
          enum: { '0': 'idle', '1': 'heating', '2': 'draining' },
        },
        {
          key: 'door_open',
          label: 'Дверь камеры',
          address: 18,
          registerType: 'input',
          dataType: 'uint16',
          precision: 0,
          enum: { '0': 'closed', '1': 'open' },
        },
      ],
    },
    {
      key: 'alarms',
      label: 'Аварии',
      params: [
        {
          key: 'alarm_bits',
          label: 'Слово аварий',
          address: 32,
          registerType: 'input',
          dataType: 'bits16',
          precision: 0,
          bits: [
            { bit: 0, key: 'high_temp', label: 'Высокая температура' },
            { bit: 1, key: 'low_temp', label: 'Низкая температура' },
            { bit: 2, key: 'probe_fault', label: 'Обрыв датчика' },
            { bit: 3, key: 'hp_switch', label: 'Реле высокого давления' },
            { bit: 4, key: 'lp_switch', label: 'Реле низкого давления' },
            { bit: 5, key: 'door_alarm', label: 'Дверь открыта долго' },
            { bit: 6, key: 'defrost_timeout', label: 'Оттайка не завершилась' },
            { bit: 8, key: 'panel_link_ok', label: 'Связь с панелью', invert: true },
          ],
        },
      ],
    },
  ],
});
