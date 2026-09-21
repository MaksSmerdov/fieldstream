/** Единицы размера, которыми пишет docker: десятичные kB/MB/GB и двоичные KiB/MiB/GiB. */
const SIZE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1_000,
  mb: 1_000_000,
  gb: 1_000_000_000,
  tb: 1_000_000_000_000,
  kib: 1_024,
  mib: 1_048_576,
  gib: 1_073_741_824,
  tib: 1_099_511_627_776,
};

const BINARY_STEPS = [
  { limit: 1_099_511_627_776, unit: 'ТиБ' },
  { limit: 1_073_741_824, unit: 'ГиБ' },
  { limit: 1_048_576, unit: 'МиБ' },
  { limit: 1_024, unit: 'КиБ' },
] as const;

/**
 * Перцентиль по выборке способом ближайшего ранга: берётся существующее значение, а не
 * усреднённое между соседями. Тот же способ даёт SQL percentile_disc, поэтому цифру инструмента
 * и цифру из базы можно сравнивать напрямую. Пустая выборка это null.
 */
export const percentile = (values: readonly number[], p: number): number | null => {
  if (values.length === 0) return null;

  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;

  return sorted[index] ?? null;
};

/** Число из ячейки выборки: пустая ячейка и не число это null. */
export const numberOf = (cell: string | null | undefined): number | null => {
  if (cell === null || cell === undefined || cell.trim() === '') return null;

  const value = Number(cell);
  return Number.isFinite(value) ? value : null;
};

/** Число с заданной точностью и пробелами по три разряда: 2 116 752, 148.3. */
export const formatNumber = (value: number, digits = 0): string => {
  const fixed = value.toFixed(digits);
  const [whole = '', fraction] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
};

/** Длительность словами: 850 мс, 4.2 с, 1 мин 20 с. */
export const formatDuration = (ms: number): string => {
  if (ms < 1_000) return `${formatNumber(ms, ms < 10 ? 1 : 0)} мс`;

  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)} с`;

  const minutes = Math.floor(seconds / 60);
  return `${minutes} мин ${Math.round(seconds - minutes * 60)} с`;
};

/** Размер двоичными единицами: 512 Б, 4.7 КиБ, 294 МиБ, 1.2 ГиБ. */
export const formatBytes = (bytes: number): string => {
  const sign = bytes < 0 ? '-' : '';
  const value = Math.abs(bytes);
  const step = BINARY_STEPS.find((item) => value >= item.limit);
  if (step === undefined) return `${sign}${formatNumber(value)} Б`;

  return `${sign}${(value / step.limit).toFixed(1)} ${step.unit}`;
};

/**
 * Размер из вывода docker в байты: image ls пишет десятичными единицами (294MB), stats и
 * system df двоичными (287.6MiB). Непонятная строка это null.
 */
export const bytesOf = (text: string): number | null => {
  const matched = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]*)\s*$/.exec(text);
  if (matched === null) return null;

  const value = Number(matched[1]);
  const unit = (matched[2] ?? '').toLowerCase();
  const factor = unit === '' ? 1 : SIZE_UNITS[unit];
  if (factor === undefined || !Number.isFinite(value)) return null;

  return value * factor;
};

/** Частота в секунду: 148.3 строк/с. */
export const formatRate = (perSecond: number, what: string): string =>
  `${formatNumber(perSecond, 1)} ${what}/с`;

/** Доля в процентах: 4.2 %. */
export const formatPercent = (share: number): string => `${formatNumber(share * 100, 1)} %`;

/** Коэффициент: 8.4x. */
export const formatRatio = (ratio: number): string => `${formatNumber(ratio, 1)}x`;
