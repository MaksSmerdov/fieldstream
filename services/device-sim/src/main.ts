import { DEMO_STAND } from '@fieldstream/device-profiles';
import { SystemClock } from '@fieldstream/domain';
import { loadEnv } from './config/env.js';
import { buildHttpApp } from './http/app.js';
import { createLineServer } from './modbus/line-server.js';
import { createSimulator } from './simulator.js';

const env = loadEnv(process.env);
const simulator = createSimulator({
  stand: DEMO_STAND,
  seed: env.SIM_SEED,
  clock: SystemClock,
  speed: env.SIM_SPEED,
  stallMs: env.SIM_STALL_MS,
});
const app = buildHttpApp(simulator, { level: env.LOG_LEVEL });
const lines = DEMO_STAND.lines.map((line) =>
  createLineServer({
    lineCode: line.code,
    host: env.SIM_HOST,
    port: line.port,
    baud: line.baud,
    turnaroundMs: env.SIM_TURNAROUND_MS,
    busTimeoutMs: env.SIM_BUS_TIMEOUT_MS,
    answer: (request) => simulator.answer(line.code, request),
    isOnline: () => simulator.isLineOnline(line.code),
    log: app.log,
  }),
);

await Promise.all(lines.map((line) => line.start()));
await app.listen({ host: env.SIM_HOST, port: env.SIM_HTTP_PORT });

app.log.info(
  { seed: env.SIM_SEED, speed: env.SIM_SPEED },
  `device-sim: ${DEMO_STAND.devices.length} приборов на ${DEMO_STAND.lines.length} линиях`,
);
app.log.info(
  { lines: DEMO_STAND.lines.map((line) => `${line.code} :${line.port} ${line.baud} бод`) },
  'Modbus TCP: порт на каждую линию, запросы в линию строго по очереди',
);
app.log.info(
  { port: env.SIM_HTTP_PORT },
  'Chaos API: POST /sim/fault, DELETE /sim/faults, POST /sim/scenario/:name, POST /sim/speed, GET /sim/state',
);

/** Штатная остановка: закрыть HTTP и порты линий. */
const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, 'остановка');
  await app.close();
  await Promise.all(lines.map((line) => line.stop()));
  process.exit(0);
};

process.once('SIGTERM', (signal) => {
  void shutdown(signal);
});
process.once('SIGINT', (signal) => {
  void shutdown(signal);
});
