import { describe, expect, it } from 'vitest';
import type { DeviceSnapshot } from '../src/events.js';
import { detectDeviceEvents } from '../src/events.js';
import { createFakeClock, toIsoTimestamp } from '../src/clock.js';

const T0 = Date.UTC(2026, 0, 1);

const snapshot = (over: Partial<DeviceSnapshot> = {}): DeviceSnapshot => ({
  deviceCode: 'RC-101',
  atMs: T0,
  status: 'online',
  mode: 'cooling',
  doorOpen: false,
  defrostActive: false,
  ...over,
});

const kinds = (prev: DeviceSnapshot | null, curr: DeviceSnapshot): string[] =>
  detectDeviceEvents(prev, curr).map((event) => event.kind);

describe('detectDeviceEvents', () => {
  it('одинаковые снимки не порождают событий', () => {
    const prev = snapshot();

    expect(detectDeviceEvents(prev, { ...prev, atMs: T0 + 10_000 })).toEqual([]);
  });

  it('первый снимок событий не порождает', () => {
    expect(detectDeviceEvents(null, snapshot())).toEqual([]);
  });

  it('смена режима даёт mode_changed с прежним и новым режимом', () => {
    const clock = createFakeClock(T0);
    clock.advance(30_000);

    const events = detectDeviceEvents(snapshot(), snapshot({ mode: 'defrost', atMs: clock.now() }));

    expect(events).toEqual([
      {
        deviceCode: 'RC-101',
        kind: 'mode_changed',
        occurredAt: toIsoTimestamp(T0 + 30_000),
        payload: { from: 'cooling', to: 'defrost' },
      },
    ]);
  });

  it('дверь открылась и закрылась', () => {
    expect(kinds(snapshot(), snapshot({ doorOpen: true }))).toEqual(['door_opened']);
    expect(kinds(snapshot({ doorOpen: true }), snapshot())).toEqual(['door_closed']);
  });

  it('оттайка началась и закончилась', () => {
    expect(kinds(snapshot(), snapshot({ defrostActive: true }))).toEqual(['defrost_started']);
    expect(kinds(snapshot({ defrostActive: true }), snapshot())).toEqual(['defrost_finished']);
  });

  it('неизвестное прошлое состояние двери события не порождает', () => {
    expect(kinds(snapshot({ doorOpen: null }), snapshot({ doorOpen: true }))).toEqual([]);
    expect(kinds(snapshot({ defrostActive: null }), snapshot({ defrostActive: true }))).toEqual([]);
  });

  it('пропажа значения события не порождает', () => {
    expect(kinds(snapshot({ doorOpen: true }), snapshot({ doorOpen: null }))).toEqual([]);
  });

  it('went_offline срабатывает и с промежуточного degraded', () => {
    const events = detectDeviceEvents(
      snapshot({ status: 'degraded' }),
      snapshot({ status: 'offline' }),
    );

    expect(events[0]).toMatchObject({ kind: 'went_offline', payload: { from: 'degraded' } });
  });

  it('came_online срабатывает при возврате прибора', () => {
    const events = detectDeviceEvents(
      snapshot({ status: 'offline' }),
      snapshot({ status: 'online' }),
    );

    expect(events[0]).toMatchObject({ kind: 'came_online', payload: { from: 'offline' } });
  });

  it('переход offline в degraded не считается возвратом в строй', () => {
    expect(kinds(snapshot({ status: 'offline' }), snapshot({ status: 'degraded' }))).toEqual([]);
  });

  it('порядок событий зафиксирован: режим, дверь, оттайка, связь', () => {
    const prev = snapshot({ status: 'offline', mode: 'cooling', doorOpen: false });
    const curr = snapshot({
      status: 'online',
      mode: 'defrost',
      doorOpen: true,
      defrostActive: true,
    });

    expect(kinds(prev, curr)).toEqual([
      'mode_changed',
      'door_opened',
      'defrost_started',
      'came_online',
    ]);
  });

  it('порядок событий тот же и при обратных переходах', () => {
    const prev = snapshot({
      status: 'online',
      mode: 'defrost',
      doorOpen: true,
      defrostActive: true,
    });
    const curr = snapshot({ status: 'offline', mode: 'cooling', doorOpen: false });

    expect(kinds(prev, curr)).toEqual([
      'mode_changed',
      'door_closed',
      'defrost_finished',
      'went_offline',
    ]);
  });

  it('время события берётся из текущего снимка', () => {
    const events = detectDeviceEvents(snapshot(), snapshot({ atMs: T0 + 5_000, doorOpen: true }));

    expect(events[0]?.occurredAt).toBe(toIsoTimestamp(T0 + 5_000));
  });
});
