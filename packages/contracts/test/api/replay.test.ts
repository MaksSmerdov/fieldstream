import type { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  FINISHED_REPLAY_RUN_STATUSES,
  REPLAY_GROUP_PREFIX,
  REPLAY_MAX_DEVICES,
  REPLAY_MAX_PATCHES,
  REPLAY_RETENTION_MS,
  replayDiffSchema,
  replayEpisodesQuerySchema,
  replayEpisodesResponseSchema,
  replayGroupIdOf,
  replayPatchSchema,
  replayRequestSchema,
  replayRulesSnapshotSchema,
  replayRunSchema,
  replayRunsResponseSchema,
} from '../../src/api/replay.js';
import type {
  ReplayDiff,
  ReplayEpisode,
  ReplayEpisodesResponse,
  ReplayRun,
} from '../../src/api/replay.js';
import { TOPICS } from '../../src/kafka/topics.manifest.js';

const FROM = '2026-09-15T09:00:00.000Z';
const HOUR_MS = 3_600_000;
const RUN_ID = '4f1c8e2a-7b3d-4c5e-9a6f-1b2c3d4e5f60';

/** Момент со сдвигом от начала окна. */
const at = (offsetMs: number): string => new Date(Date.parse(FROM) + offsetMs).toISOString();

/** Пример из демо: граница испарителя в оттайке 12 -> 8. */
const DEFROST_PATCH = { metricKey: 'evap_temp_c', mode: 'defrost', maxValue: 8 } as const;
const PATCH_KEY = { metricKey: 'evap_temp_c', mode: 'defrost' } as const;

const request = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  from: FROM,
  to: at(HOUR_MS),
  deviceCodes: ['RC-101', 'RC-102'],
  patches: [DEFROST_PATCH],
  ...overrides,
});

interface Issue {
  readonly path: (string | number)[];
  readonly message: string;
}

/** Ошибки разбора путём и текстом: пустой список значит, что значение принято. */
const issuesOf = (schema: z.ZodTypeAny, value: unknown): Issue[] => {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
};

const RUN: ReplayRun = {
  id: RUN_ID,
  status: 'done',
  requestedBy: 'engineer@fieldstream.local',
  from: FROM,
  to: at(HOUR_MS),
  deviceCodes: ['RC-101'],
  patches: [DEFROST_PATCH],
  progress: {
    offsetsTotal: 5_000_000_000,
    offsetsDone: 5_000_000_000,
    framesMatched: 360,
    framesRejected: 1,
  },
  coveredFrom: at(4_000),
  coveredTo: at(HOUR_MS - 6_000),
  groupId: replayGroupIdOf(RUN_ID),
  error: null,
  createdAt: at(HOUR_MS + 1_000),
  startedAt: at(HOUR_MS + 2_000),
  finishedAt: at(HOUR_MS + 30_000),
};

const EPISODE: ReplayEpisode = {
  deviceCode: 'RC-101',
  metricKey: 'evap_temp_c',
  mode: 'defrost',
  severity: 'warning',
  boundary: 'max',
  value: 8.6,
  threshold: 8,
  raisedAt: at(600_000),
  clearedAt: null,
  clearedValue: null,
};

describe('запрос перепрогона', () => {
  it('пример из демо принимается как есть', () => {
    expect(replayRequestSchema.parse(request())).toEqual(request());
  });

  it('срок хранения окна берётся из манифеста сырого топика', () => {
    expect(REPLAY_RETENTION_MS).toBe(TOPICS.telemetryRaw.retentionMs);
  });

  it('окно ровно в срок хранения допустимо, на миллисекунду длиннее отвергается понятным текстом', () => {
    expect(replayRequestSchema.parse(request({ to: at(REPLAY_RETENTION_MS) }))).toEqual(
      request({ to: at(REPLAY_RETENTION_MS) }),
    );
    expect(issuesOf(replayRequestSchema, request({ to: at(REPLAY_RETENTION_MS + 1) }))).toEqual([
      {
        path: ['to'],
        message: 'окно не может быть длиннее 7 сут: более старые сырые кадры брокер уже удалил',
      },
    ]);
  });

  it('конец окна должен быть позже начала', () => {
    const later = [{ path: ['to'], message: 'конец окна должен быть позже начала' }];

    expect(issuesOf(replayRequestSchema, request({ to: FROM }))).toEqual(later);
    expect(issuesOf(replayRequestSchema, request({ to: at(-1) }))).toEqual(later);
  });

  it('окно сравнивается по моменту времени, а не по записи часового пояса', () => {
    expect(
      issuesOf(
        replayRequestSchema,
        request({ from: '2026-09-15T09:30:00Z', to: '2026-09-15T12:00:00+03:00' }),
      ),
    ).toEqual([{ path: ['to'], message: 'конец окна должен быть позже начала' }]);
    expect(
      replayRequestSchema.parse(
        request({ from: '2026-09-15T09:30:00Z', to: '2026-09-15T13:00:00+03:00' }),
      ),
    ).toMatchObject({ from: '2026-09-15T09:30:00Z', to: '2026-09-15T13:00:00+03:00' });
    expect(
      replayRequestSchema.parse(
        request({ from: '2026-09-08T12:00:00+03:00', to: '2026-09-15T09:00:00Z' }),
      ),
    ).toMatchObject({ from: '2026-09-08T12:00:00+03:00' });
    expect(
      issuesOf(
        replayRequestSchema,
        request({ from: '2026-09-08T12:00:00+03:00', to: '2026-09-15T09:00:00.001Z' }),
      ),
    ).toEqual([
      {
        path: ['to'],
        message: 'окно не может быть длиннее 7 сут: более старые сырые кадры брокер уже удалил',
      },
    ]);
  });

  it('прибор нельзя выбрать дважды', () => {
    expect(
      issuesOf(replayRequestSchema, request({ deviceCodes: ['RC-101', 'RC-102', 'RC-101'] })),
    ).toEqual([{ path: ['deviceCodes', 2], message: 'прибор RC-101 выбран дважды' }]);
  });

  it('приборов от одного до всех приборов стенда', () => {
    const codes = (count: number): string[] =>
      Array.from({ length: count }, (_, index) => `RC-${100 + index}`);

    expect(issuesOf(replayRequestSchema, request({ deviceCodes: [] }))).toEqual([
      { path: ['deviceCodes'], message: 'выберите хотя бы один прибор' },
    ]);
    expect(
      replayRequestSchema.parse(request({ deviceCodes: codes(REPLAY_MAX_DEVICES) })),
    ).toMatchObject({ deviceCodes: codes(REPLAY_MAX_DEVICES) });
    expect(
      issuesOf(replayRequestSchema, request({ deviceCodes: codes(REPLAY_MAX_DEVICES + 1) })),
    ).toEqual([{ path: ['deviceCodes'], message: 'приборов не больше 24' }]);
  });

  it('правок от одной до предела запроса', () => {
    const patches = (count: number): Record<string, unknown>[] =>
      Array.from({ length: count }, (_, index) => ({
        metricKey: `metric_${index}`,
        mode: 'cooling',
        maxValue: 5,
      }));

    expect(issuesOf(replayRequestSchema, request({ patches: [] }))).toEqual([
      { path: ['patches'], message: 'нужна хотя бы одна правка' },
    ]);
    expect(
      replayRequestSchema.parse(request({ patches: patches(REPLAY_MAX_PATCHES) })),
    ).toMatchObject({ patches: patches(REPLAY_MAX_PATCHES) });
    expect(
      issuesOf(replayRequestSchema, request({ patches: patches(REPLAY_MAX_PATCHES + 1) })),
    ).toEqual([{ path: ['patches'], message: 'правок не больше 20' }]);
  });

  it('одна уставка правится в запросе один раз, тот же параметр в другом режиме можно', () => {
    expect(
      issuesOf(
        replayRequestSchema,
        request({ patches: [DEFROST_PATCH, { ...DEFROST_PATCH, maxValue: 9 }] }),
      ),
    ).toEqual([{ path: ['patches', 1], message: 'уставка evap_temp_c/defrost правится дважды' }]);
    expect(
      replayRequestSchema.parse(
        request({ patches: [DEFROST_PATCH, { ...DEFROST_PATCH, mode: 'cooling' }] }),
      ),
    ).toMatchObject({ patches: [DEFROST_PATCH, { ...DEFROST_PATCH, mode: 'cooling' }] });
  });

  it('лишние поля запроса отвергаются', () => {
    expect(issuesOf(replayRequestSchema, request({ promote: true }))).toEqual([
      { path: [], message: "Unrecognized key(s) in object: 'promote'" },
    ]);
  });
});

describe('правка уставки', () => {
  it('правка без полей кроме ключа отвергается', () => {
    expect(issuesOf(replayPatchSchema, PATCH_KEY)).toEqual([
      { path: [], message: 'правка evap_temp_c/defrost: не задано ни одного поля' },
    ]);
    expect(replayPatchSchema.parse({ ...PATCH_KEY, enabled: false })).toEqual({
      ...PATCH_KEY,
      enabled: false,
    });
  });

  it('null снимает границу, отсутствующее поле оставляет как было: такие правки принимаются', () => {
    expect(replayPatchSchema.parse({ ...PATCH_KEY, minValue: null, maxValue: 5 })).toEqual({
      ...PATCH_KEY,
      minValue: null,
      maxValue: 5,
    });
    expect(replayPatchSchema.parse({ ...PATCH_KEY, minValue: 20 })).toEqual({
      ...PATCH_KEY,
      minValue: 20,
    });
    expect(replayPatchSchema.parse({ ...PATCH_KEY, minValue: null })).toEqual({
      ...PATCH_KEY,
      minValue: null,
    });
  });

  it('заведомо неверные границы, пределы и чужие поля отвергаются', () => {
    expect(issuesOf(replayPatchSchema, { ...PATCH_KEY, minValue: null, maxValue: null })).toEqual([
      { path: ['maxValue'], message: 'правка evap_temp_c/defrost: нужна хотя бы одна граница' },
    ]);
    expect(issuesOf(replayPatchSchema, { ...PATCH_KEY, minValue: 5, maxValue: 5 })).toEqual([
      {
        path: ['minValue'],
        message: 'правка evap_temp_c/defrost: нижняя граница должна быть меньше верхней',
      },
    ]);
    expect(issuesOf(replayPatchSchema, { ...PATCH_KEY, hysteresis: 1_001 })).toEqual([
      { path: ['hysteresis'], message: 'Number must be less than or equal to 1000' },
    ]);
    expect(issuesOf(replayPatchSchema, { ...PATCH_KEY, debounceCycles: 0 })).toEqual([
      { path: ['debounceCycles'], message: 'Number must be greater than or equal to 1' },
    ]);
    expect(
      issuesOf(replayPatchSchema, { ...PATCH_KEY, maxValue: 8, severity: 'critical' }),
    ).toEqual([{ path: [], message: "Unrecognized key(s) in object: 'severity'" }]);
    expect(issuesOf(replayPatchSchema, { ...PATCH_KEY, mode: 'standby', maxValue: 8 })).toEqual([
      {
        path: ['mode'],
        message:
          "Invalid enum value. Expected 'cooling' | 'defrost' | 'service' | 'off', received 'standby'",
      },
    ]);
  });
});

describe('снимок уставок', () => {
  const rule = {
    deviceCode: 'RC-101',
    metricKey: 'evap_temp_c',
    mode: 'defrost',
    minValue: -28,
    maxValue: 8,
  };

  it('снимок разбирается общей схемой уставок вместе со значениями по умолчанию', () => {
    expect(replayRulesSnapshotSchema.parse([rule])).toEqual([
      { ...rule, hysteresis: 0, debounceCycles: 1, severity: 'warning', enabled: true },
    ]);
  });

  it('неверная уставка в снимке отвергается с номером в снимке', () => {
    expect(issuesOf(replayRulesSnapshotSchema, [rule, { ...rule, minValue: 8 }])).toEqual([
      {
        path: [1, 'minValue'],
        message: 'уставка RC-101/evap_temp_c/defrost: minValue должен быть меньше maxValue',
      },
    ]);
  });
});

describe('прогон и его итог', () => {
  it('прогон со смещениями больше int32 разбирается, небезопасное целое нет', () => {
    expect(replayRunSchema.parse(RUN)).toEqual(RUN);
    expect(
      issuesOf(replayRunSchema, {
        ...RUN,
        progress: { ...RUN.progress, offsetsTotal: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toEqual([
      {
        path: ['progress', 'offsetsTotal'],
        message: `Number must be less than or equal to ${Number.MAX_SAFE_INTEGER}`,
      },
    ]);
    expect(FINISHED_REPLAY_RUN_STATUSES).toEqual(['done', 'failed']);
  });

  it('имя временной группы строится одной функцией и проверяется по префиксу', () => {
    const wrongGroup = [
      { path: ['groupId'], message: 'имя группы перепрогона начинается с fs-replay-' },
    ];

    expect(REPLAY_GROUP_PREFIX).toBe('fs-replay-');
    expect(replayGroupIdOf(RUN_ID)).toBe(`fs-replay-${RUN_ID}`);
    expect(replayRunSchema.parse({ ...RUN, groupId: null })).toEqual({ ...RUN, groupId: null });
    expect(issuesOf(replayRunSchema, { ...RUN, groupId: 'fs-processor' })).toEqual(wrongGroup);
    expect(issuesOf(replayRunSchema, { ...RUN, groupId: REPLAY_GROUP_PREFIX })).toEqual(wrongGroup);
  });

  it('разница прогона разбирается схемой, отрицательный счёт и лишнее поле отвергаются', () => {
    const values = {
      minValue: -28,
      maxValue: 12,
      hysteresis: 1,
      debounceCycles: 2,
      severity: 'warning',
      enabled: true,
    } as const;
    const key = { deviceCode: 'RC-101', metricKey: 'evap_temp_c', mode: 'defrost' } as const;
    const row = { ...key, baseline: 0, patched: 1, added: 1, removed: 0, live: 0 };
    const diff: ReplayDiff = {
      run: RUN,
      changedRules: [{ ...key, baseline: values, patched: { ...values, maxValue: 8 } }],
      rows: [row],
    };

    expect(replayDiffSchema.parse(diff)).toEqual(diff);
    expect(issuesOf(replayDiffSchema, { ...diff, rows: [{ ...row, added: -1 }] })).toEqual([
      { path: ['rows', 0, 'added'], message: 'Number must be greater than or equal to 0' },
    ]);
    expect(
      issuesOf(replayDiffSchema, { ...diff, episodes: { baseline: [], patched: [EPISODE] } }),
    ).toEqual([{ path: [], message: "Unrecognized key(s) in object: 'episodes'" }]);
  });

  it('список прогонов разбирается схемой, срок хранения положителен', () => {
    const response = {
      serverTime: at(2 * HOUR_MS),
      retentionMs: REPLAY_RETENTION_MS,
      runs: [RUN],
      activeRun: null,
    };

    expect(replayRunsResponseSchema.parse(response)).toEqual(response);
    expect(issuesOf(replayRunsResponseSchema, { ...response, retentionMs: 0 })).toEqual([
      { path: ['retentionMs'], message: 'Number must be greater than 0' },
    ]);
  });
});

describe('эпизоды строки разницы', () => {
  const query = { deviceCode: 'RC-101', metricKey: 'evap_temp_c', mode: 'defrost' };

  it('строка запроса эпизодов строгая и называет строку целиком', () => {
    expect(replayEpisodesQuerySchema.parse(query)).toEqual(query);
    expect(issuesOf(replayEpisodesQuerySchema, { ...query, cursor: '10' })).toEqual([
      { path: [], message: "Unrecognized key(s) in object: 'cursor'" },
    ]);
    expect(issuesOf(replayEpisodesQuerySchema, { ...query, deviceCode: 'rc-101' })).toEqual([
      { path: ['deviceCode'], message: 'ожидается вид RC-101 или PM-201' },
    ]);
    expect(
      issuesOf(replayEpisodesQuerySchema, { deviceCode: 'RC-101', metricKey: 'evap_temp_c' }),
    ).toEqual([{ path: ['mode'], message: 'Required' }]);
  });

  it('ответ несёт эпизоды обоих вариантов, открытый эпизод остаётся без снятия', () => {
    const response: ReplayEpisodesResponse = {
      runId: RUN_ID,
      deviceCode: 'RC-101',
      metricKey: 'evap_temp_c',
      mode: 'defrost',
      baseline: [],
      patched: [
        { ...EPISODE, raisedAt: at(60_000), clearedAt: at(120_000), clearedValue: 7 },
        EPISODE,
      ],
    };

    expect(replayEpisodesResponseSchema.parse(response)).toEqual(response);
    expect(issuesOf(replayEpisodesResponseSchema, { ...response, runId: 'run-1' })).toEqual([
      { path: ['runId'], message: 'Invalid uuid' },
    ]);
  });
});
