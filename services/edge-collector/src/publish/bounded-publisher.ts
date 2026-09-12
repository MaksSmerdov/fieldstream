import type { OutgoingMessage } from '@fieldstream/kafka';

export interface BoundedPublisherOptions {
  readonly capacity: number;
  readonly batchSize: number;
  readonly retryDelayMs: number;
  readonly send: (batch: readonly OutgoingMessage[]) => Promise<void>;
  readonly onDrop: (count: number) => void;
  readonly onError: (error: unknown) => void;
  readonly now: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Буфер между опросом и брокером. */
export interface BoundedPublisher {
  readonly enqueue: (message: OutgoingMessage) => void;
  readonly size: () => number;
  readonly dropped: () => number;
  readonly oldestAgeMs: () => number;
  readonly drain: () => Promise<void>;
  readonly close: () => void;
}

interface Pending {
  readonly message: OutgoingMessage;
  readonly at: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Опрос кладёт сообщение и идёт дальше, отправка идёт пачками в фоне. При недоступном брокере
 * буфер растёт до ёмкости, дальше отбрасываются самые старые: потеря телеметрии вместо роста
 * памяти до падения процесса. Доходят ли данные, показывает возраст самого старого в буфере.
 */
export const createBoundedPublisher = (options: BoundedPublisherOptions): BoundedPublisher => {
  const sleep = options.sleep ?? defaultSleep;
  let queue: Pending[] = [];
  let inFlight: readonly Pending[] = [];
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
      inFlight = batch;

      try {
        await options.send(batch.map((pending) => pending.message));
        inFlight = [];
      } catch (error) {
        inFlight = [];
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
      queue.push({ message, at: options.now() });
      trim();
      kick();
    },
    size: () => queue.length,
    dropped: () => dropped,
    oldestAgeMs: () => {
      const oldest = inFlight[0] ?? queue[0];
      return oldest === undefined ? 0 : Math.max(0, options.now() - oldest.at);
    },
    drain: async () => {
      while (pumping !== null) await pumping;
    },
    close: () => {
      closed = true;
    },
  };
};
