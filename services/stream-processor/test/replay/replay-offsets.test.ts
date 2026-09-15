import { describe, expect, it } from 'vitest';
import { createPartitionTracker, planPartitions } from '../../src/replay/replay-offsets.js';

describe('смещения окна перепрогона', () => {
  it('окно по партициям: конец лога вместо -1, начало не раньше живого смещения', () => {
    const windows = planPartitions({
      starts: [
        { partition: 1, offset: '40' },
        { partition: 0, offset: '10' },
        { partition: 2, offset: '-1' },
      ],
      ends: [
        { partition: 0, offset: '25' },
        { partition: 1, offset: '50' },
        { partition: 2, offset: '-1' },
      ],
      bounds: [
        { partition: 0, low: '0', high: '30' },
        { partition: 1, low: '45', high: '60' },
        { partition: 2, low: '0', high: '7' },
      ],
    });

    expect(windows).toEqual([
      { partition: 0, start: 10n, end: 25n },
      { partition: 1, start: 45n, end: 50n },
      { partition: 2, start: 7n, end: 7n },
    ]);
  });

  it('партиция готова после смещения end - 1, живые кадры за концом окна её не завершают', () => {
    const tracker = createPartitionTracker([
      { partition: 0, start: 10n, end: 13n },
      { partition: 1, start: 5n, end: 5n },
    ]);

    expect(tracker.offsetsTotal).toBe(3);
    expect(tracker.finished()).toEqual([1]);
    expect(tracker.pending()).toEqual([{ partition: 0, offset: '10' }]);
    expect(tracker.accepts(0, '9')).toBe(false);
    expect(tracker.accepts(0, '13')).toBe(false);
    expect(tracker.accepts(3, '0')).toBe(false);

    tracker.advance(0, '10');
    tracker.advance(0, '11');
    expect(tracker.accepts(0, '11')).toBe(false);
    expect(tracker.offsetsDone()).toBe(2);
    expect(tracker.allDone()).toBe(false);
    expect(tracker.pending()).toEqual([{ partition: 0, offset: '12' }]);

    tracker.advance(0, '12');
    expect(tracker.isDone(0)).toBe(true);
    expect(tracker.allDone()).toBe(true);
    expect(tracker.offsetsDone()).toBe(3);
  });

  it('удалённые по сроку хранения смещения пропускаются, но не дальше конца окна', () => {
    const tracker = createPartitionTracker([
      { partition: 0, start: 10n, end: 20n },
      { partition: 1, start: 0n, end: 4n },
    ]);

    expect(tracker.skipLost(0, '10')).toBe(0);
    expect(tracker.skipLost(0, '14')).toBe(4);
    expect(tracker.accepts(0, '14')).toBe(true);
    expect(tracker.skipLost(0, '12')).toBe(0);
    expect(tracker.pending()[0]).toEqual({ partition: 0, offset: '14' });

    expect(tracker.skipLost(1, '9')).toBe(4);
    expect(tracker.isDone(1)).toBe(true);
    expect(tracker.skipLost(1, '12')).toBe(0);
    expect(tracker.skipLost(5, '12')).toBe(0);
  });
});
