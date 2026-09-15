import { z } from 'zod';
import { deviceCodeSchema, isoTimestampSchema } from '../primitives.js';
import { alarmRuleSchema, severitySchema } from '../messages/alarms.js';
import { TOPICS } from '../kafka/topics.manifest.js';
import { deviceModeSchema } from '../topology/device.js';

/** Срок хранения топика. У топика без срока окно перепрогона не определено. */
const retentionOf = (spec: {
  readonly name: string;
  readonly retentionMs: number | null;
}): number => {
  if (spec.retentionMs === null) {
    throw new Error(`у топика ${spec.name} нет срока хранения: окно перепрогона не определено`);
  }
  return spec.retentionMs;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Длительность человеческими словами: сутки, часы или минуты, самой крупной ровной единицей. */
const durationText = (ms: number): string => {
  if (ms % DAY_MS === 0) return `${ms / DAY_MS} сут`;
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS} ч`;
  return `${Math.ceil(ms / MINUTE_MS)} мин`;
};

/**
 * Насколько далеко назад можно перепрогнать: сырые кадры старше срока хранения топика брокер
 * уже удалил. Берётся из манифеста, чтобы окно и топик не разъехались.
 */
export const REPLAY_RETENTION_MS = retentionOf(TOPICS.telemetryRaw);

/** Пределы запроса: все приборы стенда и разумное число правок за раз. */
export const REPLAY_MAX_DEVICES = 24;
export const REPLAY_MAX_PATCHES = 20;

/** Сколько завершённых прогонов хранится вместе с эпизодами: столько же показывает список. */
export const REPLAY_KEPT_RUNS = 20;

/** Предел эпизодов одного варианта в ответе графику: сверх него показываются первые по времени. */
export const REPLAY_EPISODES_LIMIT = 2_000;

/** Временная группа потребителя перепрогона. Боевые группы с этого префикса не начинаются. */
export const REPLAY_GROUP_PREFIX = 'fs-replay-';

/** Имя временной группы прогона: единственный способ его получить. */
export const replayGroupIdOf = (runId: string): string => `${REPLAY_GROUP_PREFIX}${runId}`;

/** Поля уставки, которые правка может поменять. Ключ (метрика, режим) не правится. */
export const REPLAY_PATCH_FIELDS = [
  'minValue',
  'maxValue',
  'hysteresis',
  'debounceCycles',
  'enabled',
] as const;
export type ReplayPatchField = (typeof REPLAY_PATCH_FIELDS)[number];

/**
 * Правка уставки на время перепрогона: ключ и только меняющиеся поля. Ложится на все выбранные
 * приборы, у которых такая уставка есть.
 * null снимает границу, отсутствующее поле оставляет значение как было.
 */
export const replayPatchSchema = z
  .object({
    metricKey: z.string().min(1),
    mode: deviceModeSchema,
    minValue: z.number().nullable().optional(),
    maxValue: z.number().nullable().optional(),
    hysteresis: z.number().min(0).max(1_000).optional(),
    debounceCycles: z.number().int().min(1).max(60).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((patch, ctx) => {
    const name = `правка ${patch.metricKey}/${patch.mode}`;
    if (REPLAY_PATCH_FIELDS.every((field) => patch[field] === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name}: не задано ни одного поля`,
        path: [],
      });
    }
    if (patch.minValue === null && patch.maxValue === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name}: нужна хотя бы одна граница`,
        path: ['maxValue'],
      });
    }
    if (
      typeof patch.minValue === 'number' &&
      typeof patch.maxValue === 'number' &&
      patch.minValue >= patch.maxValue
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name}: нижняя граница должна быть меньше верхней`,
        path: ['minValue'],
      });
    }
  });
export type ReplayPatch = z.infer<typeof replayPatchSchema>;

/** Запрос перепрогона: окно в пределах срока хранения, приборы без повторов, правки без повторов. */
export const replayRequestSchema = z
  .object({
    from: isoTimestampSchema,
    to: isoTimestampSchema,
    deviceCodes: z
      .array(deviceCodeSchema)
      .min(1, 'выберите хотя бы один прибор')
      .max(REPLAY_MAX_DEVICES, `приборов не больше ${REPLAY_MAX_DEVICES}`),
    patches: z
      .array(replayPatchSchema)
      .min(1, 'нужна хотя бы одна правка')
      .max(REPLAY_MAX_PATCHES, `правок не больше ${REPLAY_MAX_PATCHES}`),
  })
  .strict()
  .superRefine((request, ctx) => {
    const windowMs = Date.parse(request.to) - Date.parse(request.from);
    if (windowMs <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'конец окна должен быть позже начала',
        path: ['to'],
      });
    } else if (windowMs > REPLAY_RETENTION_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `окно не может быть длиннее ${durationText(REPLAY_RETENTION_MS)}: более старые сырые кадры брокер уже удалил`,
        path: ['to'],
      });
    }

    const devices = new Set<string>();
    for (const [index, code] of request.deviceCodes.entries()) {
      if (devices.has(code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `прибор ${code} выбран дважды`,
          path: ['deviceCodes', index],
        });
      }
      devices.add(code);
    }

    const keys = new Set<string>();
    for (const [index, patch] of request.patches.entries()) {
      const key = `${patch.metricKey}/${patch.mode}`;
      if (keys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `уставка ${key} правится дважды`,
          path: ['patches', index],
        });
      }
      keys.add(key);
    }
  });
export type ReplayRequest = z.infer<typeof replayRequestSchema>;

/** Снимок уставок варианта в строке прогона: общий разбор для процессора и шлюза. */
export const replayRulesSnapshotSchema = z.array(alarmRuleSchema);
export type ReplayRulesSnapshot = z.infer<typeof replayRulesSnapshotSchema>;

export const replayRunStatusSchema = z.enum(['queued', 'running', 'done', 'failed']);
export type ReplayRunStatus = z.infer<typeof replayRunStatusSchema>;

/** Итоговые статусы прогона: после них ход больше не меняется. */
export const FINISHED_REPLAY_RUN_STATUSES: readonly ReplayRunStatus[] = Object.freeze([
  'done',
  'failed',
]);

/** Вариант перепрогона: уставки на момент запроса или они же с правкой. */
export const replayVariantSchema = z.enum(['baseline', 'patched']);
export type ReplayVariant = z.infer<typeof replayVariantSchema>;

const countSchema = z.number().int().min(0);

/**
 * Смещения в базе bigint, а в ответе число: сумма смещений окна не больше числа кадров за срок
 * хранения (на стенде около полутора миллионов), до 2^53 далеко, а полосе хода нужна арифметика.
 * Предел безопасного целого всё равно проверяется.
 */
const offsetCountSchema = countSchema.max(Number.MAX_SAFE_INTEGER);

/** Ход прогона: смещения сырого топика и кадры выбранных приборов внутри окна. */
export const replayProgressSchema = z
  .object({
    offsetsTotal: offsetCountSchema,
    offsetsDone: offsetCountSchema,
    framesMatched: countSchema,
    framesRejected: countSchema,
  })
  .strict();
export type ReplayProgress = z.infer<typeof replayProgressSchema>;

const groupIdMessage = `имя группы перепрогона начинается с ${REPLAY_GROUP_PREFIX}`;

/** Перепрогон так, как его показывает интерфейс. Покрытие это время первого и последнего кадра. */
export const replayRunSchema = z
  .object({
    id: z.string().uuid(),
    status: replayRunStatusSchema,
    requestedBy: z.string().min(1),
    from: isoTimestampSchema,
    to: isoTimestampSchema,
    deviceCodes: z.array(deviceCodeSchema).min(1),
    patches: z.array(replayPatchSchema),
    progress: replayProgressSchema,
    coveredFrom: isoTimestampSchema.nullable(),
    coveredTo: isoTimestampSchema.nullable(),
    groupId: z
      .string()
      .startsWith(REPLAY_GROUP_PREFIX, groupIdMessage)
      .min(REPLAY_GROUP_PREFIX.length + 1, groupIdMessage)
      .nullable(),
    error: z.string().nullable(),
    createdAt: isoTimestampSchema,
    startedAt: isoTimestampSchema.nullable(),
    finishedAt: isoTimestampSchema.nullable(),
  })
  .strict();
export type ReplayRun = z.infer<typeof replayRunSchema>;

/** Последние прогоны, идущий сейчас и срок хранения, в пределах которого можно выбрать окно. */
export const replayRunsResponseSchema = z
  .object({
    serverTime: isoTimestampSchema,
    retentionMs: z.number().int().positive(),
    runs: z.array(replayRunSchema),
    activeRun: replayRunSchema.nullable(),
  })
  .strict();
export type ReplayRunsResponse = z.infer<typeof replayRunsResponseSchema>;

/** Эпизод аларма одного варианта. Открытый к концу окна остаётся без снятия. */
export const replayEpisodeSchema = z
  .object({
    deviceCode: deviceCodeSchema,
    metricKey: z.string().min(1),
    mode: deviceModeSchema,
    severity: severitySchema,
    boundary: z.enum(['min', 'max']),
    value: z.number().nullable(),
    threshold: z.number().nullable(),
    raisedAt: isoTimestampSchema,
    clearedAt: isoTimestampSchema.nullable(),
    clearedValue: z.number().nullable(),
  })
  .strict();
export type ReplayEpisode = z.infer<typeof replayEpisodeSchema>;

/** Строка разницы, эпизоды которой нужны графику: параметры строки запроса. */
export const replayEpisodesQuerySchema = z
  .object({ deviceCode: deviceCodeSchema, metricKey: z.string().min(1), mode: deviceModeSchema })
  .strict();
export type ReplayEpisodesQuery = z.infer<typeof replayEpisodesQuerySchema>;

/**
 * Эпизоды обоих вариантов одной строки разницы. truncated: хотя бы в одном варианте эпизодов
 * больше REPLAY_EPISODES_LIMIT, и в ответе только первые по времени.
 */
export const replayEpisodesResponseSchema = z
  .object({
    runId: z.string().uuid(),
    deviceCode: deviceCodeSchema,
    metricKey: z.string().min(1),
    mode: deviceModeSchema,
    baseline: z.array(replayEpisodeSchema).max(REPLAY_EPISODES_LIMIT),
    patched: z.array(replayEpisodeSchema).max(REPLAY_EPISODES_LIMIT),
    truncated: z.boolean(),
  })
  .strict();
export type ReplayEpisodesResponse = z.infer<typeof replayEpisodesResponseSchema>;

/** Значения уставки без ключа: столбцы «Было» и «Стало». */
export const replayRuleValuesSchema = z
  .object({
    minValue: z.number().nullable(),
    maxValue: z.number().nullable(),
    hysteresis: z.number().min(0),
    debounceCycles: z.number().int().min(1).max(60),
    severity: severitySchema,
    enabled: z.boolean(),
  })
  .strict();
export type ReplayRuleValues = z.infer<typeof replayRuleValuesSchema>;

/** Уставка прибора, которую правка действительно изменила. */
export const replayChangedRuleSchema = z
  .object({
    deviceCode: deviceCodeSchema,
    metricKey: z.string().min(1),
    mode: deviceModeSchema,
    baseline: replayRuleValuesSchema,
    patched: replayRuleValuesSchema,
  })
  .strict();
export type ReplayChangedRule = z.infer<typeof replayChangedRuleSchema>;

/** Строка разницы: эпизоды обоих вариантов, новые, пропавшие и живые за покрытие прогона. */
export const replayDiffRowSchema = z
  .object({
    deviceCode: deviceCodeSchema,
    metricKey: z.string().min(1),
    mode: deviceModeSchema,
    baseline: countSchema,
    patched: countSchema,
    added: countSchema,
    removed: countSchema,
    live: countSchema,
  })
  .strict();
export type ReplayDiffRow = z.infer<typeof replayDiffRowSchema>;

/** Итог завершённого прогона: изменённые уставки и разница по строкам. Эпизоды строки отдельно. */
export const replayDiffSchema = z
  .object({
    run: replayRunSchema,
    changedRules: z.array(replayChangedRuleSchema),
    rows: z.array(replayDiffRowSchema),
  })
  .strict();
export type ReplayDiff = z.infer<typeof replayDiffSchema>;
