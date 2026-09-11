import modbusSerial from 'modbus-serial';
import type { RegisterSpan } from '@fieldstream/device-profiles';
import { hardTimeoutMs, withHardTimeout } from './timeouts.js';

/** Библиотека отдаёт конструктор через module.exports, а её типы описывают его как default. */
const ModbusRTU = modbusSerial as unknown as typeof modbusSerial.default;
type ModbusClient = InstanceType<typeof ModbusRTU>;

/** Соединение с портом шлюза одной линии. */
export interface ModbusLink {
  readonly isOpen: () => boolean;
  readonly connect: () => Promise<void>;
  readonly read: (slaveId: number, span: RegisterSpan) => Promise<number[]>;
  readonly destroy: () => void;
}

export interface ModbusLinkOptions {
  readonly host: string;
  readonly port: number;
  readonly requestTimeoutMs: number;
}

/**
 * Клиент modbus-serial с двумя таймаутами: мягкий у самой библиотеки и жёсткий поверх него.
 * После обрыва или зависания клиент не чинится, а пересоздаётся целиком.
 */
export const createModbusLink = (options: ModbusLinkOptions): ModbusLink => {
  const hardMs = hardTimeoutMs(options.requestTimeoutMs);
  let client: ModbusClient | null = null;

  const destroy = (): void => {
    const current = client;
    client = null;
    current?.destroy(() => undefined);
  };

  return {
    isOpen: () => client?.isOpen ?? false,
    connect: async () => {
      destroy();
      const created = new ModbusRTU();
      created.on('error', () => undefined);
      created.setTimeout(options.requestTimeoutMs);

      try {
        await withHardTimeout(created.connectTCP(options.host, { port: options.port }), hardMs);
      } catch (error) {
        created.destroy(() => undefined);
        throw error;
      }
      client = created;
    },
    read: async (slaveId, span) => {
      const current = client;
      if (current === null || !current.isOpen) {
        throw new Error('соединение с портом линии закрыто');
      }

      current.setID(slaveId);
      const request =
        span.registerType === 'holding'
          ? current.readHoldingRegisters(span.startAddress, span.registerCount)
          : current.readInputRegisters(span.startAddress, span.registerCount);
      const result = await withHardTimeout(request, hardMs);
      return result.data;
    },
    destroy,
  };
};
