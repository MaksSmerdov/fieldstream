import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ageMs,
  applyServerTime,
  getServerNowMs,
  getServerOffsetMs,
  isServerTimeKnown,
  resetServerClock,
} from '../src/shared/time/serverClock.js';

const LOCAL = Date.parse('2026-02-11T10:00:00.000Z');
const SERVER = Date.parse('2026-02-11T10:05:00.000Z');

describe('единая шкала времени', () => {
  beforeEach(() => {
    resetServerClock();
    vi.useFakeTimers({ now: LOCAL });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('до первого ответа сервера поправка неизвестна и равна нулю', () => {
    expect(isServerTimeKnown()).toBe(false);
    expect(getServerOffsetMs()).toBe(0);
    expect(getServerNowMs()).toBe(LOCAL);
  });

  /** Часы браузера отстают на пять минут: без поправки свежие данные выглядели бы протухшими. */
  it('берёт поправку из ответа сервера', () => {
    applyServerTime(new Date(SERVER).toISOString(), LOCAL);

    expect(isServerTimeKnown()).toBe(true);
    expect(getServerNowMs()).toBe(SERVER);
  });

  it('половина времени обращения приписывается пути до сервера', () => {
    const startedAt = LOCAL - 400;
    applyServerTime(new Date(SERVER).toISOString(), startedAt);

    expect(getServerNowMs()).toBe(SERVER + 200);
  });

  it('испорченное время сервера не сдвигает шкалу', () => {
    applyServerTime('не время', LOCAL);

    expect(isServerTimeKnown()).toBe(false);
    expect(getServerNowMs()).toBe(LOCAL);
  });

  it('возраст считается по серверным часам, будущее это ноль', () => {
    applyServerTime(new Date(SERVER).toISOString(), LOCAL);

    expect(ageMs(new Date(SERVER - 30_000).toISOString())).toBe(30_000);
    expect(ageMs(new Date(SERVER + 30_000).toISOString())).toBe(0);
    expect(ageMs(null)).toBeNull();
    expect(ageMs('мусор')).toBeNull();
  });
});
