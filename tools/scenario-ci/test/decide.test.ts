import { describe, expect, it } from 'vitest';
import type { ScenarioRun } from '@fieldstream/contracts';
import {
  CONFLICT_RETRY_MS,
  TRANSIENT_RETRY_MS,
  decide,
  isAmbiguous,
  isFinished,
  messageOf,
  ownActiveRun,
  resultLimitMs,
} from '../src/decide.js';
import type { RetryContext } from '../src/decide.js';

const start: RetryContext = {
  phase: 'start',
  reloggedIn: false,
  elapsedMs: 0,
  limitMs: 600_000,
  waitConflicts: true,
};
const read: RetryContext = { ...start, phase: 'read' };

const CREATED_AT = '2026-09-15T10:00:00.000Z';

const activeRun: ScenarioRun = {
  id: '6f1d3c8e-2a4b-4c5d-9e6f-7a8b9c0d1e2f',
  scenario: 'dead-device',
  title: 'Мёртвый прибор',
  source: 'ci',
  requestedBy: 'engineer@fieldstream.local',
  status: 'running',
  steps: [],
  error: null,
  createdAt: CREATED_AT,
  startedAt: CREATED_AT,
  finishedAt: null,
};

const listing = (run: ScenarioRun | null) => ({
  serverTime: CREATED_AT,
  scenarios: [],
  activeRun: run,
});

describe('решение о повторе', () => {
  it('запуск ждёт 202, чтение ждёт 200', () => {
    expect(decide(202, start)).toEqual({ kind: 'accept' });
    expect(decide(200, read)).toEqual({ kind: 'accept' });
    expect(decide(200, start)).toEqual({ kind: 'fail', reason: 'шлюз ответил 200' });
  });

  it('401 это вход заново, а второй 401 сразу после входа уже провал', () => {
    expect(decide(401, read)).toEqual({ kind: 'relogin' });
    expect(decide(401, { ...read, reloggedIn: true })).toEqual({
      kind: 'fail',
      reason: 'шлюз не принял токен сразу после входа',
    });
  });

  it('занятый стенд при запуске ждётся до предела, потом провал', () => {
    expect(decide(409, start)).toEqual({
      kind: 'wait',
      ms: CONFLICT_RETRY_MS,
      reason: 'стенд занят другим прогоном',
    });
    expect(decide(409, { ...start, elapsedMs: start.limitMs - CONFLICT_RETRY_MS + 1 })).toEqual({
      kind: 'fail',
      reason: 'стенд занят другим прогоном дольше 600 с',
    });
  });

  it('409 при чтении не ждётся', () => {
    expect(decide(409, read)).toEqual({ kind: 'fail', reason: 'шлюз ответил 409' });
  });

  it('стенд, занятый прогоном без итога, не ждётся, а сбои сети по-прежнему повторяются', () => {
    const stuck = { ...start, waitConflicts: false };

    expect(decide(409, stuck)).toEqual({
      kind: 'fail',
      reason: 'стенд всё ещё занят прогоном без итога',
    });
    expect(decide(null, stuck).kind).toBe('wait');
  });

  it('обрыв сети и недоступный шлюз повторяются до предела', () => {
    expect(decide(null, read)).toEqual({
      kind: 'wait',
      ms: TRANSIENT_RETRY_MS,
      reason: 'шлюз недоступен',
    });
    expect(decide(503, start).kind).toBe('wait');
    expect(decide(502, { ...read, elapsedMs: read.limitMs }).kind).toBe('fail');
  });

  it('запрос мог дойти без ответа только при обрыве и недоступном шлюзе', () => {
    expect([null, 502, 503, 504].map(isAmbiguous)).toEqual([true, true, true, true]);
    expect([202, 401, 409, 500].map(isAmbiguous)).toEqual([false, false, false, false]);
  });

  it('прочие ответы это провал без повторов', () => {
    expect(decide(404, start)).toEqual({ kind: 'fail', reason: 'шлюз ответил 404' });
    expect(decide(500, read)).toEqual({ kind: 'fail', reason: 'шлюз ответил 500' });
  });
});

describe('свой прогон после потерянного ответа', () => {
  const query = {
    scenario: 'dead-device',
    email: 'Engineer@fieldstream.local',
    notBeforeMs: Date.parse(CREATED_AT) - 1_000,
  };

  it('идущий прогон того же сценария из CI под той же учёткой подхватывается, а не запускается заново', () => {
    expect(ownActiveRun(listing(activeRun), query)).toBe(activeRun);
  });

  it('чужой, ручной, другого сценария или более ранний прогон не подхватывается', () => {
    expect(ownActiveRun(listing(null), query)).toBeNull();
    expect(ownActiveRun(listing({ ...activeRun, source: 'ui' }), query)).toBeNull();
    expect(ownActiveRun(listing({ ...activeRun, scenario: 'crc-garbage' }), query)).toBeNull();
    expect(
      ownActiveRun(listing({ ...activeRun, requestedBy: 'admin@fieldstream.local' }), query),
    ).toBeNull();
    expect(
      ownActiveRun(listing(activeRun), { ...query, notBeforeMs: Date.parse(CREATED_AT) + 1 }),
    ).toBeNull();
  });
});

describe('итог и пределы', () => {
  it('итога ждут предел сценария плюс две минуты', () => {
    expect(resultLimitMs(210)).toBe(330_000);
  });

  it('итоговые статусы только passed и failed', () => {
    expect(isFinished('passed')).toBe(true);
    expect(isFinished('failed')).toBe(true);
    expect(isFinished('queued')).toBe(false);
    expect(isFinished('running')).toBe(false);
  });

  it('текст ошибки берётся из message строкой или списком', () => {
    expect(messageOf({ message: 'идёт прогон «Мёртвый прибор»' })).toBe(
      'идёт прогон «Мёртвый прибор»',
    );
    expect(messageOf({ message: ['первое', 2, 'второе'] })).toBe('первое; второе');
    expect(messageOf({ message: '' })).toBeNull();
    expect(messageOf(null)).toBeNull();
    expect(messageOf('текст')).toBeNull();
  });
});
