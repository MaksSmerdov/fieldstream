import type { DeviceMode } from '@fieldstream/contracts';

export const MODE_LABEL: Readonly<Record<DeviceMode, string>> = {
  cooling: 'охлаждение',
  defrost: 'оттайка',
  service: 'сервис',
  off: 'выключен',
};

/**
 * Цвет полосы режима под кривыми. У охлаждения цвета нет: это обычная работа, и закрашивать
 * им весь график значило бы прятать за фоном как раз то, ради чего полоса нужна.
 */
export const MODE_BAND: Readonly<Record<DeviceMode, string | null>> = {
  cooling: null,
  defrost: 'rgba(255, 180, 70, 0.2)',
  service: 'rgba(124, 196, 255, 0.18)',
  off: 'rgba(140, 150, 165, 0.24)',
};
