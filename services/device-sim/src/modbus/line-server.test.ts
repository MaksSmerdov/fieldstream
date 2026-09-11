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
import type { Logger } from '../log.js';
import { createSimulator } from '../simulator.js';
import type { Simulator } from '../simulator.js';
import { lineTimeMs } from './frame.js';
import { createLineServer } from './line-server.js';
import type { LineServer } from './line-server.js';

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

/** Стенд и порт линии L1 на свободном порту. Скорость линии задаётся для замеров очереди. */
const startBench = async (baud = 115_200): Promise<Bench> => {
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
    turnaroundMs: 0,
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
