import type { Clock } from '@fieldstream/domain';

/** Решение по очередной записи: писать ли её и сколько одинаковых было подавлено до неё. */
export interface ThrottleDecision {
  readonly pass: boolean;
  readonly suppressed: number;
}

interface ThrottleEntry {
  readonly at: number;
  readonly suppressed: number;
}

/**
 * Подавление дублей: одинаковая запись проходит не чаще раза в окно, а следующая прошедшая
 * сообщает, сколько повторов было скрыто. Мёртвый прибор иначе заливает лог каждые 10 секунд.
 */
export const createLogThrottle = (
  clock: Clock,
  windowMs = 15_000,
): ((key: string) => ThrottleDecision) => {
  const entries = new Map<string, ThrottleEntry>();

  return (key) => {
    const now = clock.now();
    const entry = entries.get(key);

    if (entry !== undefined && now - entry.at < windowMs) {
      entries.set(key, { at: entry.at, suppressed: entry.suppressed + 1 });
      return { pass: false, suppressed: entry.suppressed + 1 };
    }

    entries.set(key, { at: now, suppressed: 0 });
    return { pass: true, suppressed: entry?.suppressed ?? 0 };
  };
};
