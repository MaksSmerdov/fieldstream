import { once } from 'node:events';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyError } from './errors.js';
import { createModbusLink } from './modbus-link.js';
import type { ModbusLink } from './modbus-link.js';

const SPAN = { registerType: 'input', startAddress: 0, registerCount: 2 } as const;

interface SilentGateway {
  readonly server: Server;
  readonly port: number;
  readonly sockets: Set<Socket>;
}

const gateways: SilentGateway[] = [];
const links: ModbusLink[] = [];

/** Шлюз, который принимает соединение и молчит: так выглядит мёртвый прибор за живым шлюзом. */
const silentGateway = (): Promise<SilentGateway> =>
  new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const gateway = {
        server,
        port: address !== null && typeof address === 'object' ? address.port : 0,
        sockets,
      };
      gateways.push(gateway);
      resolve(gateway);
    });
  });

const shutDown = (gateway: SilentGateway): Promise<void> =>
  new Promise((resolve) => {
    for (const socket of gateway.sockets) socket.destroy();
    gateway.server.close(() => {
      resolve();
    });
  });

const link = (port: number): ModbusLink => {
  const created = createModbusLink({ host: '127.0.0.1', port, requestTimeoutMs: 100 });
  links.push(created);
  return created;
};

/** Ошибка, с которой завершился промис, или null, если он выполнился. */
const failureOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => null,
    (error: unknown) => error,
  );

afterEach(async () => {
  for (const created of links.splice(0)) created.destroy();
  await Promise.all(gateways.splice(0).map(shutDown));
});

describe('соединение с портом шлюза на настоящем клиенте modbus-serial', () => {
  it('молчание прибора за живым шлюзом классифицируется как таймаут, а не как обрыв', async () => {
    const gateway = await silentGateway();
    const connection = link(gateway.port);
    await connection.connect();

    const error = await failureOf(connection.read(1, SPAN));

    expect(classifyError(error)).toBe('timeout');
    expect(connection.isOpen()).toBe(true);
  });

  it('destroy действительно рвёт TCP-соединение, а не оставляет его висеть у шлюза', async () => {
    const gateway = await silentGateway();
    const connection = link(gateway.port);
    await connection.connect();
    const [socket] = [...gateway.sockets];
    if (socket === undefined) throw new Error('шлюз не увидел соединения');

    const closed = once(socket, 'close');
    connection.destroy();
    await closed;

    expect(connection.isOpen()).toBe(false);
    expect(gateway.sockets.size).toBe(0);
  });

  it('повторное подключение закрывает прежнее соединение', async () => {
    const gateway = await silentGateway();
    const connection = link(gateway.port);
    await connection.connect();
    const [first] = [...gateway.sockets];
    if (first === undefined) throw new Error('шлюз не увидел соединения');

    const closed = once(first, 'close');
    await connection.connect();
    await closed;

    expect(gateway.sockets.size).toBe(1);
  });

  it('закрытый порт шлюза даёт обрыв', async () => {
    const gateway = await silentGateway();
    await shutDown(gateway);

    const error = await failureOf(link(gateway.port).connect());

    expect(classifyError(error)).toBe('disconnected');
  });

  it('чтение без открытого соединения сразу отказывает как обрыв', async () => {
    const error = await failureOf(link(1).read(1, SPAN));

    expect(classifyError(error)).toBe('disconnected');
  });
});
