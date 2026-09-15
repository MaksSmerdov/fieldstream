import { afterEach, describe, expect, it } from 'vitest';
import modbusSerial from 'modbus-serial';
import { simFaultRequestSchema } from '@fieldstream/contracts';
import type { SimFaultRequest, SimFaultRequestInput } from '@fieldstream/contracts';
import {
  DEMO_STAND,
  buildDeviceReadPlan,
  listPlanEntries,
  paramWordsInBlock,
  rc2000Profile,
} from '@fieldstream/device-profiles';
import { createFakeClock } from '@fieldstream/domain';
import { decodeParam } from '@fieldstream/modbus-codec';
import type { Logger } from '../../src/log.js';
import { createSimulator } from '../../src/simulator.js';
import type { Simulator } from '../../src/simulator.js';
import { lineTimeMs } from '../../src/modbus/frame.js';
import { createLineServer } from '../../src/modbus/line-server.js';
import type { LineServer, LineServerOptions } from '../../src/modbus/line-server.js';
import { createTurnaround } from '../../src/modbus/turnaround.js';

/** Библиотека отдаёт конструктор через module.exports, а её типы описывают его как default. */
const ModbusRTU = modbusSerial as unknown as typeof modbusSerial.default;
type ModbusClient = InstanceType<typeof ModbusRTU>;

const noop = (): void => undefined;
const silentLog: Logger = { debug: noop, info: noop, warn: noop, error: noop };
const START = Date.parse('2026-09-11T10:00:00Z');

const servers: LineServer[] = [];
const clients: ModbusClient[] = [];

interface Bench {
  readonly sim: Simulator;
  readonly server: LineServer;
}

type Turnaround = Pick<LineServerOptions, 'turnaroundMs' | 'turnaroundJitterMs'>;

const NO_TURNAROUND: Turnaround = { turnaroundMs: 0, turnaroundJitterMs: 0 };

/** Стенд и порт линии L1 на свободном порту. Скорость и задержка ответа задаются для замеров. */
const startBench = async (baud = 115_200, turnaround = NO_TURNAROUND): Promise<Bench> => {
  const sim = createSimulator({
    stand: DEMO_STAND,
    seed: 'line-test',
    clock: createFakeClock(START),
    speed: 1,
    stallMs: 400,
  });
  const server = createLineServer({
    lineCode: 'L1',
    host: '127.0.0.1',
    port: 0,
    baud,
    seed: 'line-test',
    ...turnaround,
    busTimeoutMs: 20,
    answer: (request) => sim.answer('L1', request),
    isOnline: () => sim.isLineOnline('L1'),
    log: silentLog,
    syncIntervalMs: 20,
  });
  await server.start();
  servers.push(server);
  return { sim, server };
};

const connect = async (port: number, unitId: number, timeoutMs = 300): Promise<ModbusClient> => {
  const client = new ModbusRTU();
  await client.connectTCP('127.0.0.1', { port });
  client.setID(unitId);
  client.setTimeout(timeoutMs);
  clients.push(client);
  return client;
};

const fault = (input: SimFaultRequestInput): SimFaultRequest => simFaultRequestSchema.parse(input);

const waitFor = async (condition: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('условие не наступило');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

afterEach(async () => {
  for (const client of clients.splice(0)) client.close(noop);
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe('порт линии и клиент modbus-serial', () => {
  it('по склеенному плану отдаёт ровно то, что показывает эталон стенда', async () => {
    const { sim, server } = await startBench();
    const client = await connect(server.port(), 1);
    const expected = sim.state().devices.find((device) => device.deviceCode === 'RC-101')?.values;
    const params = new Map(
      listPlanEntries(rc2000Profile).map((entry) => [entry.param.key, entry.param]),
    );

    for (const block of buildDeviceReadPlan(rc2000Profile).blocks) {
      const result =
        block.registerType === 'holding'
          ? await client.readHoldingRegisters(block.startAddress, block.registerCount)
          : await client.readInputRegisters(block.startAddress, block.registerCount);

      for (const key of block.paramKeys) {
        const param = params.get(key);
        if (param === undefined) continue;
        expect(decodeParam(paramWordsInBlock(block, result.data, param), param)).toEqual(
          expected?.[key],
        );
      }
    }
  });

  it('исключение прибора доходит до клиента с кодом', async () => {
    const { sim, server } = await startBench();
    sim.applyFault(
      fault({ targetKind: 'device', targetId: 'RC-102', kind: 'exception', exceptionCode: 11 }),
    );
    const client = await connect(server.port(), 2);

    await expect(client.readInputRegisters(0, 4)).rejects.toMatchObject({ modbusCode: 11 });
  });

  it('искажённый кадр клиент отвергает по длине', async () => {
    const { sim, server } = await startBench();
    sim.applyFault(fault({ targetKind: 'device', targetId: 'RC-101', kind: 'crc' }));
    const client = await connect(server.port(), 1);

    await expect(client.readInputRegisters(0, 4)).rejects.toThrow(/Data length error/);
  });

  it('молчащий прибор даёт таймаут, а сосед по линии отвечает', async () => {
    const { sim, server } = await startBench();
    sim.applyFault(fault({ targetKind: 'device', targetId: 'RC-101', kind: 'silent' }));
    const silent = await connect(server.port(), 1);
    const neighbour = await connect(server.port(), 2);

    await expect(silent.readInputRegisters(0, 4)).rejects.toThrow(/Timed out/);
    await expect(neighbour.readInputRegisters(0, 4)).resolves.toMatchObject({
      data: expect.any(Array) as unknown,
    });
  });

  it('на адрес, которого нет на линии, никто не отвечает', async () => {
    const { server } = await startBench();
    const client = await connect(server.port(), 9);

    await expect(client.readInputRegisters(0, 1)).rejects.toThrow(/Timed out/);
  });

  it('зависший обмен держит линию: запрос с другого соединения ждёт своей очереди', async () => {
    const { sim, server } = await startBench();
    sim.applyFault(fault({ targetKind: 'device', targetId: 'RC-101', kind: 'stall' }));
    const stalled = await connect(server.port(), 1, 2000);
    const neighbour = await connect(server.port(), 2, 2000);

    const started = performance.now();
    const stalledRead = stalled.readInputRegisters(0, 4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await neighbour.readInputRegisters(0, 4);
    await stalledRead;

    expect(performance.now() - started).toBeGreaterThanOrEqual(390);
  });

  it('два соединения не опрашивают линию параллельно: обмены идут по очереди со временем кадра', async () => {
    const baud = 1200;
    const { server } = await startBench(baud);
    const first = await connect(server.port(), 1, 2000);
    const second = await connect(server.port(), 2, 2000);
    const oneExchangeMs = lineTimeMs(8 + 5 + 2 * 4, baud);

    const started = performance.now();
    await Promise.all([first.readInputRegisters(0, 4), second.readInputRegisters(0, 4)]);

    expect(performance.now() - started).toBeGreaterThanOrEqual(2 * oneExchangeMs - 5);
  });

  it('каждый ответ ждёт свою добавку разброса из последовательности линии', async () => {
    const baud = 115_200;
    const { server } = await startBench(baud, { turnaroundMs: 10, turnaroundJitterMs: 200 });
    const client = await connect(server.port(), 1, 2000);
    const next = createTurnaround({ seed: 'line-test', lineCode: 'L1', baseMs: 10, jitterMs: 200 });
    const expected = Array.from({ length: 8 }, () => next());
    const frameMs = lineTimeMs(8 + 5 + 2 * 4, baud);

    expect(Math.max(...expected) - Math.min(...expected)).toBeGreaterThan(50);

    for (const delayMs of expected) {
      const started = performance.now();
      await client.readInputRegisters(0, 4);
      const elapsed = performance.now() - started;

      expect(elapsed).toBeGreaterThanOrEqual(frameMs + delayMs - 2);
      expect(elapsed).toBeLessThan(frameMs + delayMs + 60);
    }
  });

  it('зависший обмен не получает добавку разброса', async () => {
    const { sim, server } = await startBench(115_200, {
      turnaroundMs: 0,
      turnaroundJitterMs: 1000,
    });
    sim.applyFault(fault({ targetKind: 'device', targetId: 'RC-101', kind: 'stall' }));
    const client = await connect(server.port(), 1, 2000);
    const next = createTurnaround({ seed: 'line-test', lineCode: 'L1', baseMs: 0, jitterMs: 1000 });
    const skipped = Array.from({ length: 3 }, () => next());

    expect(Math.max(...skipped)).toBeGreaterThan(150);

    for (let attempt = 0; attempt < skipped.length; attempt += 1) {
      const started = performance.now();
      await client.readInputRegisters(0, 4);
      const elapsed = performance.now() - started;

      expect(elapsed).toBeGreaterThanOrEqual(398);
      expect(elapsed).toBeLessThan(400 + 150);
    }
  });

  it('обрыв шлюза закрывает порт, после снятия поломки порт открывается снова', async () => {
    const { sim, server } = await startBench();
    sim.applyFault(fault({ targetKind: 'line', targetId: 'L1', kind: 'offline' }));
    await waitFor(() => !server.listening());

    await expect(connect(server.port(), 1)).rejects.toMatchObject({ code: 'ECONNREFUSED' });

    sim.clearFaults();
    await waitFor(() => server.listening());
    const client = await connect(server.port(), 1);
    await expect(client.readInputRegisters(0, 4)).resolves.toMatchObject({
      data: expect.any(Array) as unknown,
    });
  });
});
