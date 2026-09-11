import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import type { Logger } from '../log.js';
import {
  RTU_READ_REQUEST_BYTES,
  lineTimeMs,
  parseRequest,
  replyFrame,
  rtuBytesOf,
  splitFrames,
} from './frame.js';
import type { Answer, ModbusRequest } from './frame.js';

export interface LineServerOptions {
  readonly lineCode: string;
  readonly host: string;
  readonly port: number;
  readonly baud: number;
  readonly turnaroundMs: number;
  readonly busTimeoutMs: number;
  readonly answer: (request: ModbusRequest) => Answer;
  readonly isOnline: () => boolean;
  readonly log: Logger;
  readonly syncIntervalMs?: number;
}

/** TCP-порт шлюза, за которым висит одна линия RS-485. */
export interface LineServer {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly port: () => number;
  readonly listening: () => boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Жив ли сокет прямо сейчас: за время обмена на линии клиент мог уже отключиться. */
const isAlive = (socket: Socket): boolean => !socket.destroyed;

/**
 * Порт линии. Запросы со всех соединений встают в одну очередь: RS-485 разделяемая среда,
 * параллельный опрос в ней физически невозможен. Каждый обмен занимает линию на время
 * передачи кадров на её скорости, поэтому лишний запрос виден в длительности цикла.
 */
export const createLineServer = (options: LineServerOptions): LineServer => {
  const { lineCode, log } = options;
  const sockets = new Set<Socket>();
  let server: Server | null = null;
  let boundPort = options.port;
  let queue: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  let syncing = false;

  const serve = async (socket: Socket, request: ModbusRequest): Promise<void> => {
    if (!isAlive(socket)) return;

    const answer = options.answer(request);
    if (answer.kind === 'silent') {
      await sleep(lineTimeMs(RTU_READ_REQUEST_BYTES, options.baud) + options.busTimeoutMs);
      return;
    }

    const frame = replyFrame(request, answer);
    const exchangeMs =
      lineTimeMs(RTU_READ_REQUEST_BYTES + rtuBytesOf(frame), options.baud) + options.turnaroundMs;
    await sleep(exchangeMs + answer.stallMs);

    if (isAlive(socket)) socket.write(frame);
  };

  const enqueue = (socket: Socket, request: ModbusRequest): void => {
    queue = queue
      .then(() => serve(socket, request))
      .catch((error: unknown) => {
        log.error({ err: error, line: lineCode }, 'сбой обработки запроса');
      });
  };

  const onConnection = (socket: Socket): void => {
    if (!options.isOnline()) {
      socket.destroy();
      return;
    }

    sockets.add(socket);
    socket.setNoDelay(true);
    let pending: Buffer = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
      const split = splitFrames(Buffer.concat([pending, chunk]));
      pending = split.rest;
      for (const frame of split.frames) enqueue(socket, parseRequest(frame));

      if (split.broken) {
        log.warn({ line: lineCode }, 'поток без заголовка Modbus TCP, соединение закрыто');
        socket.destroy();
      }
    });
    socket.on('error', () => {
      socket.destroy();
    });
    socket.on('close', () => {
      sockets.delete(socket);
    });
  };

  const listen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const created = createServer(onConnection);
      created.once('error', reject);
      created.listen(boundPort, options.host, () => {
        created.off('error', reject);
        created.on('error', (error) => {
          log.error({ err: error, line: lineCode }, 'ошибка порта линии');
        });

        const address = created.address();
        if (address !== null && typeof address === 'object') boundPort = address.port;
        server = created;
        resolve();
      });
    });

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      const current = server;
      server = null;
      for (const socket of sockets) socket.destroy();
      sockets.clear();

      if (current === null) {
        resolve();
        return;
      }
      current.close(() => {
        resolve();
      });
    });

  /** Приводит порт в соответствие с поломкой offline: закрывает его или открывает снова. */
  const sync = async (): Promise<void> => {
    if (syncing) return;
    syncing = true;

    try {
      const online = options.isOnline();
      if (online && server === null) {
        await listen();
        log.info({ line: lineCode, port: boundPort }, 'порт линии снова открыт');
      }
      if (!online && server !== null) {
        await close();
        log.warn({ line: lineCode, port: boundPort }, 'порт линии закрыт: шлюз недоступен');
      }
    } catch (error) {
      log.error({ err: error, line: lineCode }, 'не удалось переключить порт линии');
    } finally {
      syncing = false;
    }
  };

  return {
    start: async () => {
      await listen();
      timer = setInterval(() => {
        void sync();
      }, options.syncIntervalMs ?? 500);
      timer.unref();
    },
    stop: async () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      await close();
    },
    port: () => boundPort,
    listening: () => server !== null,
  };
};
