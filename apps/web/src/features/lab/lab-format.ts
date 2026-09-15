/** Длительность коротко: до секунды в миллисекундах, дальше в секундах. */
export const durationText = (ms: number): string => {
  const value = Math.max(0, Math.round(ms));
  if (value < 1000) return `${value} мс`;

  const seconds = value / 1000;
  const text =
    seconds >= 10
      ? String(Math.round(seconds))
      : seconds.toFixed(1).replace('.', ',').replace(/,0$/, '');

  return `${text} с`;
};

/** Задержка со знаком: разброс относительно ступени. */
export const signedDurationText = (ms: number): string =>
  `${ms < 0 ? '−' : '+'}${durationText(Math.abs(ms))}`;

/** Обратный отсчёт минутами и секундами, например 4:05. */
export const countdownText = (ms: number): string => {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};
