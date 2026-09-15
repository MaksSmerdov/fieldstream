import { describe, expect, it } from 'vitest';
import {
  pipelineGroupSchema,
  pipelineMemberSchema,
  pipelinePartitionSchema,
  pipelineResponseSchema,
} from '@fieldstream/contracts';
import {
  EMPTY_LAG_HISTORY,
  MEMBER_TONES,
  SNAPSHOT_STALE_MS,
  appendLagSample,
  edgeShape,
  isSnapshotStale,
  lagTrend,
  logMessages,
  memberTones,
  partitionBarShape,
  sparkline,
} from '../src/features/pipeline/pipeline-geometry.js';
import type {
  LagHistory,
  LagPoint,
  LagSample,
} from '../src/features/pipeline/pipeline-geometry.js';

const AT = Date.parse('2026-02-11T10:00:00.000Z');

const iso = (offsetMs: number): string => new Date(AT + offsetMs).toISOString();

/** Снимок для истории из полей ответа, прошедших схемы контракта. */
const sample = (offsetMs: number, lag: number, groupId = 'fs-processor'): LagSample => ({
  sampledAt: pipelineResponseSchema.shape.sampledAt.parse(iso(offsetMs)) ?? '',
  groups: [
    pipelineGroupSchema.parse({
      groupId,
      state: 'Stable',
      members: [],
      lag: [],
      totalLag: lag,
      lagSeconds: null,
    }),
  ],
});

const pointsOf = (history: LagHistory, groupId = 'fs-processor'): readonly LagPoint[] =>
  history.series.get(groupId) ?? [];

describe('полоса партиции', () => {
  it('отметка коммита и отставание считаются долями лога от low до high', () => {
    const shape = partitionBarShape(100, 300, 250);

    expect(shape.place).toBe('inside');
    expect(shape.emptyLog).toBe(false);
    expect(shape.commitPct).toBeCloseTo(75);
    expect(shape.lagFromPct).toBeCloseTo(75);
    expect(shape.lagWidthPct).toBeCloseTo(25);
  });

  it('коммит на конце лога это полная полоса без отставания', () => {
    const shape = partitionBarShape(0, 40, 40);

    expect(shape.commitPct).toBe(100);
    expect(shape.lagWidthPct).toBe(0);
  });

  it('пустой лог low == high не делит на ноль', () => {
    const shape = partitionBarShape(120, 120, 120);

    expect(shape.emptyLog).toBe(true);
    expect(shape.commitPct).toBe(100);
    expect(shape.lagWidthPct).toBe(0);
    expect(Number.isFinite(shape.lagFromPct)).toBe(true);
  });

  /** Срок хранения мог удалить начало лога раньше, чем группа его прочла. */
  it('коммит раньше начала лога прижимается к левому краю, отставание на всю полосу', () => {
    const shape = partitionBarShape(500, 900, 200);

    expect(shape.place).toBe('before-log');
    expect(shape.commitPct).toBe(0);
    expect(shape.lagFromPct).toBe(0);
    expect(shape.lagWidthPct).toBe(100);
  });

  it('коммит за концом лога прижимается к правому краю без отставания', () => {
    const shape = partitionBarShape(0, 100, 180);

    expect(shape.place).toBe('after-log');
    expect(shape.commitPct).toBe(100);
    expect(shape.lagWidthPct).toBe(0);
  });

  it('если коммита не было, отметки нет и отставание не рисуется', () => {
    const shape = partitionBarShape(0, 100, null);

    expect(shape.place).toBe('none');
    expect(shape.commitPct).toBeNull();
    expect(shape.lagWidthPct).toBe(0);
  });

  it('сообщений в логе это сумма high - low по партициям', () => {
    expect(
      logMessages(
        [
          { partition: 0, low: 100, high: 340 },
          { partition: 1, low: 0, high: 60 },
          { partition: 2, low: 10, high: 10 },
        ].map((item) => pipelinePartitionSchema.parse(item)),
      ),
    ).toBe(300);
  });
});

describe('история отставания', () => {
  it('снимки копятся по группам в порядке времени', () => {
    let history = EMPTY_LAG_HISTORY;
    history = appendLagSample(history, sample(0, 10));
    history = appendLagSample(history, sample(2_000, 25));

    expect(pointsOf(history)).toEqual([
      { atMs: AT, lag: 10 },
      { atMs: AT + 2_000, lag: 25 },
    ]);
  });

  /** Опрос раз в две секунды часто возвращает тот же снимок брокера. */
  it('повтор того же sampledAt не добавляет точку и не меняет состояние', () => {
    const once = appendLagSample(EMPTY_LAG_HISTORY, sample(0, 10));
    const twice = appendLagSample(once, sample(0, 99));

    expect(twice).toBe(once);
    expect(pointsOf(twice)).toHaveLength(1);
  });

  it('снимок старше последнего не принимается', () => {
    const history = appendLagSample(EMPTY_LAG_HISTORY, sample(10_000, 10));

    expect(appendLagSample(history, sample(4_000, 50))).toBe(history);
  });

  it('точки старше окна отбрасываются', () => {
    let history = EMPTY_LAG_HISTORY;
    const limits = { windowMs: 5_000, maxPoints: 100 };
    for (const offset of [0, 2_000, 4_000, 6_000, 8_000]) {
      history = appendLagSample(history, sample(offset, offset), limits);
    }

    expect(pointsOf(history).map((point) => point.atMs - AT)).toEqual([4_000, 6_000, 8_000]);
  });

  it('длина истории ограничена числом точек', () => {
    let history = EMPTY_LAG_HISTORY;
    const limits = { windowMs: 3_600_000, maxPoints: 3 };
    for (let index = 0; index < 10; index += 1) {
      history = appendLagSample(history, sample(index * 2_000, index), limits);
    }

    expect(pointsOf(history).map((point) => point.lag)).toEqual([7, 8, 9]);
  });

  it('пропавшая группа хранит прежние точки, пока они не выйдут из окна', () => {
    const limits = { windowMs: 5_000, maxPoints: 100 };
    let history = appendLagSample(EMPTY_LAG_HISTORY, sample(0, 5, 'fs-old'), limits);
    history = appendLagSample(history, sample(2_000, 1, 'fs-new'), limits);

    expect(pointsOf(history, 'fs-old')).toHaveLength(1);

    history = appendLagSample(history, sample(8_000, 2, 'fs-new'), limits);

    expect(history.series.has('fs-old')).toBe(false);
    expect(pointsOf(history, 'fs-new')).toHaveLength(1);
  });

  /** Намеренно негодный вход: проверяется защита, схема такой момент не пропустила бы. */
  it('неразборчивый момент снимка пропускается', () => {
    const history = appendLagSample(EMPTY_LAG_HISTORY, { sampledAt: 'вчера', groups: [] });

    expect(history).toBe(EMPTY_LAG_HISTORY);
  });
});

describe('направление отставания', () => {
  const points = (...lags: number[]): LagPoint[] =>
    lags.map((lag, index) => ({ atMs: AT + index * 2_000, lag }));

  it('рост без единого спада на последних точках', () => {
    expect(lagTrend(points(1, 5, 5, 9))).toBe('growing');
  });

  it('один скачок вниз посреди роста это уже не рост', () => {
    expect(lagTrend(points(10, 4, 12))).toBe('steady');
  });

  it('сокращение и ровное отставание различаются', () => {
    expect(lagTrend(points(9, 6, 2))).toBe('shrinking');
    expect(lagTrend(points(3, 3, 3))).toBe('steady');
  });

  it('по двум точкам направление не судится', () => {
    expect(lagTrend(points(1, 50))).toBe('unknown');
  });
});

describe('линия истории', () => {
  it('время растягивается на ширину, отставание от нуля до максимума', () => {
    const line = sparkline(
      [
        { atMs: AT, lag: 0 },
        { atMs: AT + 1_000, lag: 50 },
        { atMs: AT + 2_000, lag: 100 },
      ],
      200,
      48,
      4,
    );

    expect(line.maxLag).toBe(100);
    expect(line.path).toBe('M0 44 L100 24 L200 4');
  });

  it('одна точка рисуется ровной линией, пустая история пустым путём', () => {
    expect(sparkline([{ atMs: AT, lag: 0 }], 100, 20, 0).path).toBe('M0 20 H100');
    expect(sparkline([], 100, 20).path).toBe('');
  });
});

describe('схема и пороги', () => {
  it('связи на одной высоте идут прямой, на разной ломаной со стрелкой в левый край', () => {
    const from = { x: 0, y: 0, width: 100, height: 40 };

    expect(edgeShape(from, { x: 200, y: 0, width: 100, height: 40 }).path).toBe('M100 20 H200');

    const elbow = edgeShape(from, { x: 200, y: 100, width: 100, height: 40 });

    expect(elbow.path).toBe('M100 20 H150 V120 H200');
    expect(elbow.arrow).toBe('200,120 192,116 192,124');
    expect(elbow.labelX).toBe(175);
  });

  it('узел под узлом соединяется вертикально сверху вниз', () => {
    const shape = edgeShape(
      { x: 0, y: 0, width: 100, height: 40 },
      { x: 0, y: 100, width: 100, height: 40 },
    );

    expect(shape.path).toBe('M50 40 V100');
    expect(shape.arrow).toBe('50,100 46,92 54,92');
  });

  it('снимок устаревает только после порога, неизвестный возраст не устаревший', () => {
    expect(isSnapshotStale(SNAPSHOT_STALE_MS)).toBe(false);
    expect(isSnapshotStale(SNAPSHOT_STALE_MS + 1)).toBe(true);
    expect(isSnapshotStale(null)).toBe(false);
  });

  it('цвета участников идут по кругу', () => {
    const members = Array.from({ length: MEMBER_TONES + 1 }, (_, index) =>
      pipelineMemberSchema.parse({
        memberId: `m-${String(index)}`,
        clientId: `processor-${String(index)}`,
        host: '/10.0.0.1',
        assignments: [],
      }),
    );
    const tones = memberTones(members);

    expect(tones.get('m-0')).toBe(0);
    expect(tones.get(`m-${String(MEMBER_TONES)}`)).toBe(0);
    expect(tones.get('m-1')).toBe(1);
  });
});
