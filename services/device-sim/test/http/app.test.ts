import { afterEach, describe, expect, it } from 'vitest';
import { simFaultSchema, simStateSchema } from '@fieldstream/contracts';
import { DEMO_STAND } from '@fieldstream/device-profiles';
import { createFakeClock } from '@fieldstream/domain';
import type { FastifyInstance } from 'fastify';
import { createSimulator } from '../../src/simulator.js';
import { buildHttpApp } from '../../src/http/app.js';

const apps: FastifyInstance[] = [];

const makeApp = (): FastifyInstance => {
  const sim = createSimulator({
    stand: DEMO_STAND,
    seed: 'http-test',
    clock: createFakeClock(Date.parse('2026-09-11T10:00:00Z')),
    speed: 1,
    stallMs: 5000,
  });
  const app = buildHttpApp(sim, false);
  apps.push(app);
  return app;
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Chaos API', () => {
  it('GET /health отвечает ok', async () => {
    const response = await makeApp().inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toEqual({ status: 'ok' });
  });

  it('GET /sim/state отдаёт эталон по контракту', async () => {
    const response = await makeApp().inject({ method: 'GET', url: '/sim/state' });
    const state = simStateSchema.parse(response.json<unknown>());

    expect(response.statusCode).toBe(200);
    expect(state.devices).toHaveLength(24);
    expect(state.lines).toHaveLength(4);
  });

  it('неверное описание поломки даёт 400 в формате problem+json с путями полей', async () => {
    const response = await makeApp().inject({
      method: 'POST',
      url: '/sim/fault',
      payload: { targetKind: 'device', targetId: 'RC-101', kind: 'offline' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json<unknown>()).toMatchObject({
      status: 400,
      issues: [{ path: 'kind', message: 'поломка "offline" вносится только на линию' }],
    });
  });

  it('поломка вносится с кодом 201 и возвращается по контракту', async () => {
    const response = await makeApp().inject({
      method: 'POST',
      url: '/sim/fault',
      payload: { targetKind: 'device', targetId: 'RC-101', kind: 'silent', ttlSec: 60 },
    });
    const body = simFaultSchema.parse(response.json<unknown>());

    expect(response.statusCode).toBe(201);
    expect(body).toMatchObject({ targetId: 'RC-101', kind: 'silent' });
  });

  it('неизвестная цель даёт 404, неприменимая поломка 422', async () => {
    const app = makeApp();
    const missing = await app.inject({
      method: 'POST',
      url: '/sim/fault',
      payload: { targetKind: 'device', targetId: 'RC-199', kind: 'silent' },
    });
    const inapplicable = await app.inject({
      method: 'POST',
      url: '/sim/fault',
      payload: { targetKind: 'device', targetId: 'PM-201', kind: 'door_stuck' },
    });

    expect(missing.statusCode).toBe(404);
    expect(inapplicable.statusCode).toBe(422);
    expect(inapplicable.json<unknown>()).toMatchObject({ title: 'Поломка неприменима' });
  });

  it('оттайка по команде принимается с кодом 202', async () => {
    const response = await makeApp().inject({
      method: 'POST',
      url: '/sim/fault',
      payload: { targetKind: 'device', targetId: 'RC-103', kind: 'defrost' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json<unknown>()).toEqual({ action: 'defrost_started', deviceCode: 'RC-103' });
  });

  it('DELETE /sim/faults снимает все поломки', async () => {
    const app = makeApp();
    await app.inject({
      method: 'POST',
      url: '/sim/fault',
      payload: { targetKind: 'line', targetId: 'L1', kind: 'crc' },
    });
    const removed = await app.inject({ method: 'DELETE', url: '/sim/faults' });
    const state = simStateSchema.parse(
      (await app.inject({ method: 'GET', url: '/sim/state' })).json<unknown>(),
    );

    expect(removed.statusCode).toBe(204);
    expect(state.faults).toEqual([]);
  });

  it('сценарий запускается по имени, неизвестный сценарий даёт 404', async () => {
    const app = makeApp();
    const unknown = await app.inject({ method: 'POST', url: '/sim/scenario/meteor' });
    const blackout = await app.inject({ method: 'POST', url: '/sim/scenario/line-blackout' });
    const state = simStateSchema.parse(
      (await app.inject({ method: 'GET', url: '/sim/state' })).json<unknown>(),
    );

    expect(unknown.statusCode).toBe(404);
    expect(blackout.statusCode).toBe(202);
    expect(state.lines.find((line) => line.lineCode === 'L2')?.online).toBe(false);
  });

  it('ускорение принимается в пределах 1..60', async () => {
    const app = makeApp();
    const tooFast = await app.inject({
      method: 'POST',
      url: '/sim/speed',
      payload: { factor: 100 },
    });
    const ok = await app.inject({ method: 'POST', url: '/sim/speed', payload: { factor: 10 } });

    expect(tooFast.statusCode).toBe(400);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<unknown>()).toEqual({ speed: 10 });
  });
});
