/** Лестница переподключения: от 1 до 30 секунд, множитель 2, джиттер плюс-минус 10 процентов. */
export const RECONNECT = Object.freeze({
  baseMs: 1_000,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.1,
});

/** Выбранная задержка вместе с тем, из чего она сложилась: её публикуют событием как факт. */
export interface BackoffStep {
  readonly baseMs: number;
  readonly jitterMs: number;
  readonly chosenMs: number;
}

/** Задержка перед попыткой номер attempt (с нуля). Джиттер нужен, чтобы линии не синхронизировались. */
export const reconnectDelay = (attempt: number, random: () => number): BackoffStep => {
  const baseMs = Math.min(RECONNECT.baseMs * RECONNECT.factor ** attempt, RECONNECT.maxMs);
  const jitterMs = Math.round((random() * 2 - 1) * RECONNECT.jitter * baseMs);
  return { baseMs, jitterMs, chosenMs: baseMs + jitterMs };
};
