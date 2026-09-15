import type { Clock } from '@fieldstream/domain';

/** Настройки записи хода. */
export interface ProgressWriterOptions<T> {
  readonly intervalMs: number;
  readonly clock: Clock;
  readonly write: (value: T) => Promise<void>;
  readonly onError: (error: unknown) => void;
}

/** Запись хода: push отдаёт снимок, close дожидается начатых записей и отбрасывает отложенный. */
export interface ProgressWriter<T> {
  readonly push: (value: T) => void;
  readonly close: () => Promise<void>;
}

/**
 * Пишет ход не чаще раза в интервал. Снимки внутри интервала схлопываются в последний, и он
 * уходит в конце интервала. Записи идут строго по очереди, сбой записи не останавливает следующие.
 */
export const createProgressWriter = <T>(options: ProgressWriterOptions<T>): ProgressWriter<T> => {
  const { intervalMs, clock, write, onError } = options;
  let pending: { readonly value: T } | null = null;
  let lastWriteMs: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let chain: Promise<void> = Promise.resolve();
  let closed = false;

  const flush = (): void => {
    timer = null;
    if (pending === null) return;

    const { value } = pending;
    pending = null;
    lastWriteMs = clock.now();
    chain = chain.then(() => write(value)).catch(onError);
  };

  return {
    push: (value) => {
      if (closed) return;

      pending = { value };
      if (timer !== null) return;

      const waitMs = lastWriteMs === null ? 0 : lastWriteMs + intervalMs - clock.now();
      if (waitMs <= 0) flush();
      else timer = setTimeout(flush, waitMs);
    },
    close: async () => {
      closed = true;
      pending = null;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }

      await chain;
    },
  };
};
