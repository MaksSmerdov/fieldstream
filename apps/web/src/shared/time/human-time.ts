import { ageMs } from './serverClock.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Длительность словами. Секунды нужны на живом экране, где данные меняются каждые десять
 * секунд, а сутки и часы для истории: «7200 с» человеку ничего не говорит.
 */
export const spanText = (ms: number): string => {
  const length = Math.max(0, ms);
  if (length < MINUTE_MS) return `${String(Math.round(length / 1000))} с`;
  if (length < HOUR_MS) return `${String(Math.round(length / MINUTE_MS))} мин`;
  if (length < DAY_MS) return `${String(Math.round(length / HOUR_MS))} ч`;

  return `${String(Math.round(length / DAY_MS))} сут`;
};

/** Возраст момента по серверным часам. Пустой момент это не ноль, а «данных не было». */
export const agoText = (iso: string | null, absent = 'данных не было'): string => {
  const age = ageMs(iso);

  return age === null ? absent : `${spanText(age)} назад`;
};

const MOMENT = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });

/** Момент по местным часам вкладки: машинная строка в подсказке ничего не объясняет. */
export const momentText = (iso: string | null): string =>
  iso === null ? 'неизвестно' : MOMENT.format(new Date(Date.parse(iso)));
