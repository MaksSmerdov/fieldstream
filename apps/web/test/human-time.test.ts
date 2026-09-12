import { afterEach, describe, expect, it } from 'vitest';
import { agoText, momentText, spanText } from '../src/shared/time/human-time.js';
import { applyServerTime, resetServerClock } from '../src/shared/time/serverClock.js';

afterEach(() => {
  resetServerClock();
});

describe('время словами', () => {
  it('длительность растёт по единицам: секунды, минуты, часы, сутки', () => {
    expect(spanText(5_000)).toBe('5 с');
    expect(spanText(90_000)).toBe('2 мин');
    expect(spanText(3 * 3_600_000)).toBe('3 ч');
    expect(spanText(2 * 86_400_000)).toBe('2 сут');
  });

  it('отрицательная длительность это ноль, а не минус пять секунд', () => {
    expect(spanText(-5_000)).toBe('0 с');
  });

  /** Возраст считается по серверным часам: часы вкладки могут уйти на десять минут. */
  it('возраст берётся от серверного времени, а не от часов вкладки', () => {
    const serverNow = Date.now() + 600_000;
    applyServerTime(new Date(serverNow).toISOString(), Date.now());

    const age = agoText(new Date(serverNow - 120_000).toISOString());

    expect(age).toBe('2 мин назад');
  });

  it('пустой момент объясняется словами, а не пустым местом', () => {
    expect(agoText(null)).toBe('данных не было');
    expect(agoText(null, 'неизвестно сколько')).toBe('неизвестно сколько');
    expect(momentText(null)).toBe('неизвестно');
  });

  it('момент показывается по местным часам вкладки', () => {
    const iso = '2026-02-11T10:00:00.000Z';
    const shown = momentText(iso);

    expect(shown).toContain(String(new Date(Date.parse(iso)).getFullYear()).slice(2));
    expect(shown).not.toContain('T');
  });
});
