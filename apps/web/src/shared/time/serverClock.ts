/**
 * Единая шкала времени. Весь интерфейс спрашивает «сейчас» только здесь: при расхождении
 * часов браузера и сервера на десять минут свежие данные выглядят протухшими, а протухшие
 * свежими. Это единственный модуль во фронте, которому разрешено читать системные часы.
 */
let offsetMs = 0;
let known = false;

// eslint-disable-next-line no-restricted-syntax -- ровно та самая разрешённая точка доступа к часам
const localNowMs = (): number => Date.now();

/**
 * Поправка по ответу сервера. Половина времени обращения приписывается пути туда:
 * без этого поправка на медленной сети систематически смещена.
 */
export const applyServerTime = (serverIso: string, requestStartedMs: number): void => {
  const serverMs = Date.parse(serverIso);
  if (Number.isNaN(serverMs)) return;

  const finishedMs = localNowMs();
  const halfTripMs = Math.max(0, (finishedMs - requestStartedMs) / 2);
  offsetMs = serverMs + halfTripMs - finishedMs;
  known = true;
};

/** Текущее серверное время. До первого ответа сервера это просто часы браузера. */
export const getServerNowMs = (): number => localNowMs() + offsetMs;

export const startedAtMs = (): number => localNowMs();

/** Поправка известна: до первого ответа интерфейс не имеет права утверждать, что данные свежие. */
export const isServerTimeKnown = (): boolean => known;

export const getServerOffsetMs = (): number => offsetMs;

/** Возраст момента по серверным часам. Отрицательный возраст не бывает: будущее это ноль. */
export const ageMs = (iso: string | null): number | null => {
  if (iso === null) return null;
  const atMs = Date.parse(iso);
  if (Number.isNaN(atMs)) return null;

  return Math.max(0, getServerNowMs() - atMs);
};

/** Только для тестов: вернуть шкалу в исходное состояние. */
export const resetServerClock = (): void => {
  offsetMs = 0;
  known = false;
};
