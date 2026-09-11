import type { OutgoingMessage } from '@fieldstream/kafka';

export interface BoundedPublisherOptions {
  readonly capacity: number;
  readonly batchSize: number;
  readonly retryDelayMs: number;
  readonly send: (batch: readonly OutgoingMessage[]) => Promise<void>;
  readonly onDrop: (count: number) => void;
  readonly onError: (error: unknown) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Буфер между опросом и брокером. */
export interface BoundedPublisher {
  readonly enqueue: (message: OutgoingMessage) => void;
  readonly size: () => number;
  readonly dropped: () => number;
  readonly drain: () => Promise<void>;
  readonly close: () => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Опрос кладёт сообщение и сразу идёт дальше, отправка идёт пачками в фоне. Если брокер недоступен,
 * буфер растёт до ёмкости, а дальше отбрасываются самые старые сообщения: осознанная потеря
 * телеметрии вместо роста памяти до падения процесса.
 */
export const createBoundedPublisher = (options: BoundedPublisherOptions): BoundedPublisher => {
  const sleep = options.sleep ?? defaultSleep;
  let queue: OutgoingMessage[] = [];
  let dropped = 0;
  let pumping: Promise<void> | null = null;
  let closed = false;

  const trim = (): void => {
    const excess = queue.length - options.capacity;
    if (excess <= 0) return;
    queue = queue.slice(excess);
    dropped += excess;
    options.onDrop(excess);
  };

  const pump = async (): Promise<void> => {
    while (queue.length > 0 && !closed) {
      const batch = queue.slice(0, options.batchSize);
      queue = queue.slice(batch.length);

      try {
        await options.send(batch);
      } catch (error) {
        options.onError(error);
        queue = [...batch, ...queue];
        trim();
        await sleep(options.retryDelayMs);
      }
    }
  };

  const kick = (): void => {
    if (pumping !== null || closed) return;
    pumping = pump().finally(() => {
      pumping = null;
      if (queue.length > 0) kick();
    });
  };

  return {
    enqueue: (message) => {
      queue.push(message);
      trim();
      kick();
    },
    size: () => queue.length,
    dropped: () => dropped,
    drain: async () => {
      while (pumping !== null) await pumping;
    },
    close: () => {
      closed = true;
    },
  };
};
