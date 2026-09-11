interface HourMemo {
  readonly minute: number;
  readonly hour: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const lastHour = new Map<string, HourMemo>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;

  const created = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  });
  formatters.set(timeZone, created);
  return created;
};

/** Местное время суток площадки в часах, от 0 до 24. Внутри одной минуты не пересчитывается. */
export const localHour = (ms: number, timeZone: string): number => {
  const minute = Math.floor(ms / 60_000);
  const cached = lastHour.get(timeZone);
  if (cached !== undefined && cached.minute === minute) return cached.hour;

  let hours = 0;
  let minutes = 0;
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type === 'hour') hours = Number(part.value) % 24;
    if (part.type === 'minute') minutes = Number(part.value);
  }

  const hour = hours + minutes / 60;
  lastHour.set(timeZone, { minute, hour });
  return hour;
};

/** Температура в помещении вокруг камер: около 16 °C ночью и до 24 °C к трём часам дня. */
export const ambientTempC = (hour: number): number =>
  20 + 4 * Math.cos(((hour - 15) / 24) * 2 * Math.PI);

/** Загрузка склада сменой: ноль ночью, единица в середине дня. */
export const activityLevel = (hour: number): number =>
  hour <= 7 || hour >= 21 ? 0 : Math.sin(((hour - 7) / 14) * Math.PI);
