import { describe, expect, it } from 'vitest';
import { buildModeSpans } from '../src/mode-spans.js';

const FROM = '2026-02-11T00:00:00.000Z';
const TO = '2026-02-11T06:00:00.000Z';

describe('отрезки режимов', () => {
  it('без смен окно закрыто одним отрезком', () => {
    expect(buildModeSpans({ from: FROM, to: TO, initialMode: 'cooling', changes: [] })).toEqual([
      { mode: 'cooling', from: FROM, to: TO },
    ]);
  });

  /** Дыра в полосе читалась бы как «режим неизвестен», поэтому отрезки идут встык. */
  it('смены внутри окна дают непрерывную цепочку', () => {
    const spans = buildModeSpans({
      from: FROM,
      to: TO,
      initialMode: 'cooling',
      changes: [
        { at: '2026-02-11T02:00:00.000Z', mode: 'defrost' },
        { at: '2026-02-11T02:20:00.000Z', mode: 'cooling' },
      ],
    });

    expect(spans.map((span) => span.mode)).toEqual(['cooling', 'defrost', 'cooling']);
    expect(spans[0]?.to).toBe(spans[1]?.from);
    expect(spans[1]?.to).toBe(spans[2]?.from);
    expect(spans.at(-1)?.to).toBe(TO);
  });

  it('смена до начала окна только задаёт исходный режим', () => {
    const spans = buildModeSpans({
      from: FROM,
      to: TO,
      initialMode: 'cooling',
      changes: [{ at: '2026-02-10T23:00:00.000Z', mode: 'service' }],
    });

    expect(spans).toEqual([{ mode: 'service', from: FROM, to: TO }]);
  });

  it('смена после конца окна не попадает в полосу', () => {
    const spans = buildModeSpans({
      from: FROM,
      to: TO,
      initialMode: 'off',
      changes: [{ at: '2026-02-11T07:00:00.000Z', mode: 'cooling' }],
    });

    expect(spans).toEqual([{ mode: 'off', from: FROM, to: TO }]);
  });

  it('повтор того же режима не режет отрезок на два', () => {
    const spans = buildModeSpans({
      from: FROM,
      to: TO,
      initialMode: 'cooling',
      changes: [
        { at: '2026-02-11T01:00:00.000Z', mode: 'cooling' },
        { at: '2026-02-11T03:00:00.000Z', mode: 'defrost' },
      ],
    });

    expect(spans).toEqual([
      { mode: 'cooling', from: FROM, to: '2026-02-11T03:00:00.000Z' },
      { mode: 'defrost', from: '2026-02-11T03:00:00.000Z', to: TO },
    ]);
  });

  it('перевёрнутое окно отрезков не даёт', () => {
    expect(buildModeSpans({ from: TO, to: FROM, initialMode: 'cooling', changes: [] })).toEqual([]);
  });
});
