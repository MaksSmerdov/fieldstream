import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { replayRunSchema } from '@fieldstream/contracts';
import { loadReplayRun } from '../../src/store/replay.js';

const ROW = {
  id: '4f1c8e2a-7b3d-4c5e-9a6f-1b2c3d4e5f60',
  requested_by: 'engineer@fieldstream.local',
  from_ts: new Date('2026-09-15T09:00:00.000Z'),
  to_ts: new Date('2026-09-15T10:00:00.000Z'),
  device_codes: ['RC-101', 'RC-102'],
  patches: [{ metricKey: 'evap_temp_c', mode: 'defrost', maxValue: 8 }],
  status: 'running',
  offsets_total: '5000000000',
  offsets_done: '12',
  frames_matched: 10,
  frames_rejected: 1,
  covered_from: new Date('2026-09-15T09:00:04.000Z'),
  covered_to: null,
  group_id: 'fs-replay-4f1c8e2a-7b3d-4c5e-9a6f-1b2c3d4e5f60',
  error: null,
  created_at: new Date('2026-09-15T10:00:00.000Z'),
  started_at: new Date('2026-09-15T10:00:01.000Z'),
  finished_at: null,
};

/** Клиент базы, который на любой запрос отдаёт одну строку. */
const clientWith = (row: Record<string, unknown>): pg.ClientBase =>
  ({ query: () => Promise.resolve({ rows: [row] }) }) as unknown as pg.ClientBase;

describe('строка перепрогона', () => {
  it('смещения bigint приходят строками, а отдаются числами в виде контракта', async () => {
    const run = await loadReplayRun(clientWith(ROW), ROW.id);

    expect(run).toMatchObject({
      from: '2026-09-15T09:00:00.000Z',
      progress: {
        offsetsTotal: 5_000_000_000,
        offsetsDone: 12,
        framesMatched: 10,
        framesRejected: 1,
      },
      coveredFrom: '2026-09-15T09:00:04.000Z',
      coveredTo: null,
      patches: ROW.patches,
    });
    expect(replayRunSchema.parse(run)).toEqual(run);
  });

  it('неразборчивая правка в jsonb не роняет чтение прогона', async () => {
    const run = await loadReplayRun(clientWith({ ...ROW, patches: [{ broken: true }] }), ROW.id);

    expect(run?.patches).toEqual([]);
  });
});
