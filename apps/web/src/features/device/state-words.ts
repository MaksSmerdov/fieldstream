/**
 * Коды состояний прибора словами. Словарь профиля машинный: по нему процессор узнаёт оттайку
 * и открытую дверь, поэтому переводится он здесь, а не в самом профиле. Незнакомый код
 * показывается как есть: врать про состояние хуже, чем показать его машинное имя.
 */
const STATE_WORDS: Readonly<Record<string, string>> = {
  stopped: 'остановлен',
  starting: 'пуск',
  running: 'работает',
  unloading: 'разгрузка',
  idle: 'нет',
  heating: 'нагрев',
  draining: 'слив',
  closed: 'закрыта',
  open: 'открыта',
};

export const stateWords = (
  states: Readonly<Record<string, string>> | null,
): Readonly<Record<string, string>> | null => {
  if (states === null) return null;

  return Object.fromEntries(
    Object.entries(states).map(([code, name]) => [code, STATE_WORDS[name] ?? name]),
  );
};
