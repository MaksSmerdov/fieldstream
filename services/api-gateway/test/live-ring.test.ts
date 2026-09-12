import { describe, expect, it } from 'vitest';
import { LiveRing } from '../src/events/live-ring.js';

const fill = (ring: LiveRing, count: number): void => {
  for (let index = 0; index < count; index += 1) {
    ring.append('reading', [`device:RC-10${String(index % 3)}`], { index });
  }
};

describe('кольцо живого канала', () => {
  it('нумерует события подряд и держит эпоху в идентификаторе', () => {
    const ring = new LiveRing(10, 42);

    expect(ring.append('hello', [], {}).id).toBe('42:1');
    expect(ring.append('ping', [], {}).id).toBe('42:2');
  });

  it('хранит только последние события', () => {
    const ring = new LiveRing(5, 1);
    fill(ring, 12);

    expect(ring.size()).toBe(5);
  });

  it('новому клиенту досылать нечего', () => {
    const ring = new LiveRing(5, 1);
    fill(ring, 3);

    expect(ring.since(null)).toEqual({ events: [], resync: false, reason: null });
  });

  it('вернувшемуся клиенту досылает ровно пропущенное', () => {
    const ring = new LiveRing(10, 1);
    fill(ring, 5);

    const backfill = ring.since('1:3');

    expect(backfill.resync).toBe(false);
    expect(backfill.events.map((event) => event.id)).toEqual(['1:4', '1:5']);
  });

  /** Перезапуск шлюза меняет эпоху: старые номера теперь ничего не значат. */
  it('чужая эпоха это требование перечитать всё', () => {
    const ring = new LiveRing(10, 7);
    fill(ring, 3);

    expect(ring.since('6:2')).toMatchObject({ resync: true, reason: 'unknown_epoch' });
    expect(ring.since('мусор')).toMatchObject({ resync: true, reason: 'unknown_epoch' });
  });

  it('номер из будущего это тоже требование перечитать всё', () => {
    const ring = new LiveRing(10, 1);
    fill(ring, 3);

    expect(ring.since('1:99')).toMatchObject({ resync: true, reason: 'unknown_epoch' });
  });

  /** Клиент проспал дольше, чем живёт кольцо: досылать нечего, и молчать об этом нельзя. */
  it('слишком старый номер это требование перечитать всё', () => {
    const ring = new LiveRing(5, 1);
    fill(ring, 20);

    expect(ring.since('1:2')).toMatchObject({ resync: true, reason: 'too_old' });
  });

  it('граница кольца ещё досылается, а на шаг раньше уже нет', () => {
    const ring = new LiveRing(5, 1);
    fill(ring, 10);

    expect(ring.since('1:5').resync).toBe(false);
    expect(ring.since('1:4').resync).toBe(true);
  });
});
