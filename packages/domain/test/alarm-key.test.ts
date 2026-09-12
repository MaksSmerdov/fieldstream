import { describe, expect, it } from 'vitest';
import { alarmDedupeKey, alarmIdOf } from '../src/alarm-key.js';

const episode = {
  deviceCode: 'RC-101',
  metricKey: 'supply_temp_c',
  mode: 'cooling' as const,
  raisedAt: Date.parse('2026-02-11T10:15:30.000Z'),
};

describe('ключ эпизода аларма', () => {
  it('не зависит от того, подъём это или снятие', () => {
    expect(alarmDedupeKey(episode)).toBe('RC-101|supply_temp_c|cooling|2026-02-11T10:15:30.000Z');
  });

  it('различает режимы: одна метрика в оттайке это другой эпизод', () => {
    expect(alarmDedupeKey({ ...episode, mode: 'defrost' })).not.toBe(alarmDedupeKey(episode));
  });

  /** Реплей истории должен дать те же идентификаторы, что и боевой прогон. */
  it('идентификатор считается из ключа и повторяем', () => {
    const id = alarmIdOf(alarmDedupeKey(episode));

    expect(id).toBe(alarmIdOf(alarmDedupeKey({ ...episode })));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).not.toBe(alarmIdOf(alarmDedupeKey({ ...episode, raisedAt: episode.raisedAt + 1 })));
  });
});
