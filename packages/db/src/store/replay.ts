import type pg from 'pg';
import { z } from 'zod';
import { replayPatchSchema } from '@fieldstream/contracts';
import type {
  AlarmRule,
  DeviceMode,
  ReplayEpisodesQuery,
  ReplayEpisodesResponse,
  ReplayPatch,
  ReplayProgress,
  ReplayRun,
  ReplayRunStatus,
  ReplayVariant,
  Severity,
} from '@fieldstream/contracts';

interface ReplayRunRow {
  readonly id: string;
  readonly requested_by: string;
  readonly from_ts: Date;
  readonly to_ts: Date;
  readonly device_codes: string[];
  readonly patches: unknown;
  readonly status: ReplayRunStatus;
  readonly offsets_total: string;
  readonly offsets_done: string;
  readonly frames_matched: number;
  readonly frames_rejected: number;
  readonly covered_from: Date | null;
  readonly covered_to: Date | null;
  readonly group_id: string | null;
  readonly error: string | null;
  readonly created_at: Date;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
}

interface ReplayRunRulesRow {
  readonly rules_baseline: unknown;
  readonly rules_patched: unknown;
}

const RUN_COLUMNS = `id, requested_by, from_ts, to_ts, device_codes, patches, status, offsets_total,
  offsets_done, frames_matched, frames_rejected, covered_from, covered_to, group_id, error,
  created_at, started_at, finished_at`;

const patchesSchema = z.array(replayPatchSchema);

/** Правки из jsonb: неразборчивая запись не роняет чтение прогона. */
const patchesOf = (value: unknown): ReplayPatch[] => {
  const parsed = patchesSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
};

const isoOrNull = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

/** Строка прогона в вид контракта. Смещения bigint приходят строкой и с запасом влезают в число. */
const toRun = (row: ReplayRunRow): ReplayRun => ({
  id: row.id,
  status: row.status,
  requestedBy: row.requested_by,
  from: row.from_ts.toISOString(),
  to: row.to_ts.toISOString(),
  deviceCodes: row.device_codes,
  patches: patchesOf(row.patches),
  progress: {
    offsetsTotal: Number(row.offsets_total),
    offsetsDone: Number(row.offsets_done),
    framesMatched: row.frames_matched,
    framesRejected: row.frames_rejected,
  },
  coveredFrom: isoOrNull(row.covered_from),
  coveredTo: isoOrNull(row.covered_to),
  groupId: row.group_id,
  error: row.error,
  createdAt: row.created_at.toISOString(),
  startedAt: isoOrNull(row.started_at),
  finishedAt: isoOrNull(row.finished_at),
});

const firstRun = (rows: readonly ReplayRunRow[]): ReplayRun | null => {
  const row = rows[0];
  return row === undefined ? null : toRun(row);
};

/** Исполнитель прогона: экземпляр процессора и момент его последнего пульса. */
export interface ReplayRunOwner {
  readonly instanceId: string;
  readonly heartbeatAt: string;
}

/** Новый прогон: окно, приборы, правка и снимок уставок обоих вариантов. */
export interface ReplayRunEntry {
  readonly requestedBy: string;
  readonly from: string;
  readonly to: string;
  readonly deviceCodes: readonly string[];
  readonly patches: readonly ReplayPatch[];
  readonly rulesBaseline: readonly AlarmRule[];
  readonly rulesPatched: readonly AlarmRule[];
}

/**
 * Ставит прогон в очередь. Уникальный индекс держит один активный прогон на стенд: занятый
 * стенд даёт null, а не исключение базы.
 */
export const createReplayRun = async (
  client: pg.ClientBase,
  entry: ReplayRunEntry,
): Promise<ReplayRun | null> => {
  const result = await client.query<ReplayRunRow>(
    `INSERT INTO core.replay_run
       (requested_by, from_ts, to_ts, device_codes, patches, rules_baseline, rules_patched)
     VALUES ($1, $2, $3, $4::text[], $5::jsonb, $6::jsonb, $7::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING ${RUN_COLUMNS}`,
    [
      entry.requestedBy,
      entry.from,
      entry.to,
      [...entry.deviceCodes],
      JSON.stringify(entry.patches),
      JSON.stringify(entry.rulesBaseline),
      JSON.stringify(entry.rulesPatched),
    ],
  );

  return firstRun(result.rows);
};

export const loadReplayRun = async (
  client: pg.ClientBase,
  id: string,
): Promise<ReplayRun | null> => {
  const result = await client.query<ReplayRunRow>(
    `SELECT ${RUN_COLUMNS} FROM core.replay_run WHERE id = $1`,
    [id],
  );

  return firstRun(result.rows);
};

/** Последние прогоны, новые первыми. */
export const loadRecentReplayRuns = async (
  client: pg.ClientBase,
  limit: number,
): Promise<ReplayRun[]> => {
  const result = await client.query<ReplayRunRow>(
    `SELECT ${RUN_COLUMNS} FROM core.replay_run ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );

  return result.rows.map(toRun);
};

/** Идущий или ждущий прогон стенда. */
export const loadActiveReplayRun = async (client: pg.ClientBase): Promise<ReplayRun | null> => {
  const result = await client.query<ReplayRunRow>(
    `SELECT ${RUN_COLUMNS} FROM core.replay_run
     WHERE status IN ('queued', 'running')
     ORDER BY created_at DESC LIMIT 1`,
  );

  return firstRun(result.rows);
};

/** Снимок уставок обоих вариантов как лежит в строке: разбирается replayRulesSnapshotSchema. */
export interface ReplayRunRules {
  readonly baseline: unknown;
  readonly patched: unknown;
}

export const loadReplayRunRules = async (
  client: pg.ClientBase,
  id: string,
): Promise<ReplayRunRules | null> => {
  const result = await client.query<ReplayRunRulesRow>(
    `SELECT rules_baseline, rules_patched FROM core.replay_run WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];

  return row === undefined ? null : { baseline: row.rules_baseline, patched: row.rules_patched };
};

/** Забранный прогон вместе со снимком уставок, по которому он исполняется. */
export interface ClaimedReplayRun {
  readonly run: ReplayRun;
  readonly rules: ReplayRunRules;
}

/**
 * Забирает самый старый ждущий прогон за этим экземпляром. SKIP LOCKED отдаёт прогон, который
 * прямо сейчас забирает другой экземпляр, только ему одному. В отличие от повторной подачи
 * вызывается вне транзакции и фиксируется сразу: прогон длинный, брошенный подберёт проверка пульса.
 */
export const claimReplayRun = async (
  client: pg.ClientBase,
  owner: ReplayRunOwner,
): Promise<ClaimedReplayRun | null> => {
  const result = await client.query<ReplayRunRow & ReplayRunRulesRow>(
    `UPDATE core.replay_run
     SET status = 'running', instance_id = $1, heartbeat_at = $2, started_at = $2
     WHERE id = (
       SELECT id FROM core.replay_run
       WHERE status = 'queued'
       ORDER BY created_at LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING ${RUN_COLUMNS}, rules_baseline, rules_patched`,
    [owner.instanceId, owner.heartbeatAt],
  );
  const row = result.rows[0];

  return row === undefined
    ? null
    : { run: toRun(row), rules: { baseline: row.rules_baseline, patched: row.rules_patched } };
};

/** Ход прогона между пульсами: счёты, покрытие окна и имя временной группы. */
export interface ReplayRunProgressUpdate {
  readonly progress: ReplayProgress;
  readonly coveredFrom: string | null;
  readonly coveredTo: string | null;
  readonly groupId: string | null;
}

/**
 * Пишет ход вместе с пульсом. Пустое имя группы не затирает записанное. false значит, что прогон
 * уже завершён или отобран: работу пора остановить без записи итога.
 */
export const updateReplayProgress = async (
  client: pg.ClientBase,
  id: string,
  owner: ReplayRunOwner,
  update: ReplayRunProgressUpdate,
): Promise<boolean> => {
  const result = await client.query(
    `UPDATE core.replay_run
     SET offsets_total = $2, offsets_done = $3, frames_matched = $4, frames_rejected = $5,
         covered_from = $6, covered_to = $7, group_id = coalesce($8, group_id), heartbeat_at = $9
     WHERE id = $1 AND status = 'running' AND instance_id = $10`,
    [
      id,
      update.progress.offsetsTotal,
      update.progress.offsetsDone,
      update.progress.framesMatched,
      update.progress.framesRejected,
      update.coveredFrom,
      update.coveredTo,
      update.groupId,
      owner.heartbeatAt,
      owner.instanceId,
    ],
  );

  return (result.rowCount ?? 0) > 0;
};

/** Какие прогоны считать брошенными: в работе, а пульс старше staleBefore. */
export interface StaleReplayRunFilter {
  readonly staleBefore: string;
}

/** Брошенные прогоны завершаются с ошибкой. Ждущие не трогаются. Возвращает число завершённых. */
export const failStaleReplayRuns = async (
  client: pg.ClientBase,
  filter: StaleReplayRunFilter,
  error: string,
  finishedAt: string,
): Promise<number> => {
  const result = await client.query(
    `UPDATE core.replay_run SET status = 'failed', error = $1, finished_at = $2
     WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < $3)`,
    [error, finishedAt, filter.staleBefore],
  );

  return result.rowCount ?? 0;
};

/** Какие ждущие прогоны считать никем не забранными: поставлены раньше queuedBefore. */
export interface ExpiredReplayRunFilter {
  readonly queuedBefore: string;
}

/**
 * Завершает с ошибкой ждущие прогоны, которые ни один процессор не забрал вовремя: иначе такой
 * прогон навсегда занимает стенд. Вызывает шлюз. Идущие и завершённые не трогаются.
 * Возвращает число завершённых.
 */
export const failExpiredQueuedReplayRuns = async (
  client: pg.ClientBase,
  filter: ExpiredReplayRunFilter,
  error: string,
  finishedAt: string,
): Promise<number> => {
  const result = await client.query(
    `UPDATE core.replay_run SET status = 'failed', error = $1, finished_at = $2
     WHERE status = 'queued' AND created_at < $3`,
    [error, finishedAt, filter.queuedBefore],
  );

  return result.rowCount ?? 0;
};

/** Итог прогона: счёты и покрытие окна на момент завершения. */
export interface ReplayRunOutcome {
  readonly progress: ReplayProgress;
  readonly coveredFrom: string | null;
  readonly coveredTo: string | null;
  readonly finishedAt: string;
}

/**
 * Успешно завершает прогон: итог пишет только исполнитель и только один раз. Порядок итога
 * обязателен. Одна транзакция, первым этот вызов (он блокирует строку прогона), при false откат
 * и выход без записи; затем insertReplayEpisodes и pruneReplayRuns, потом фиксация. При ошибке
 * сначала откат, потом failReplayRun на чистом соединении.
 */
export const finishReplayRun = async (
  client: pg.ClientBase,
  id: string,
  owner: Pick<ReplayRunOwner, 'instanceId'>,
  outcome: ReplayRunOutcome,
): Promise<boolean> => {
  const result = await client.query(
    `UPDATE core.replay_run
     SET status = 'done', offsets_total = $2, offsets_done = $3, frames_matched = $4,
         frames_rejected = $5, covered_from = $6, covered_to = $7, error = NULL, finished_at = $8
     WHERE id = $1 AND status = 'running' AND instance_id = $9`,
    [
      id,
      outcome.progress.offsetsTotal,
      outcome.progress.offsetsDone,
      outcome.progress.framesMatched,
      outcome.progress.framesRejected,
      outcome.coveredFrom,
      outcome.coveredTo,
      outcome.finishedAt,
      owner.instanceId,
    ],
  );

  return (result.rowCount ?? 0) > 0;
};

/** Причина провала прогона. */
export interface ReplayRunFailure {
  readonly error: string;
  readonly finishedAt: string;
}

/**
 * Завершает прогон с ошибкой: пишет только исполнитель и только один раз. После сбоя в транзакции
 * итога вызывается уже после отката и на чистом соединении, иначе провал откатится вместе с итогом.
 */
export const failReplayRun = async (
  client: pg.ClientBase,
  id: string,
  owner: Pick<ReplayRunOwner, 'instanceId'>,
  failure: ReplayRunFailure,
): Promise<boolean> => {
  const result = await client.query(
    `UPDATE core.replay_run SET status = 'failed', error = $2, finished_at = $3
     WHERE id = $1 AND status = 'running' AND instance_id = $4`,
    [id, failure.error.slice(0, 1_000), failure.finishedAt, owner.instanceId],
  );

  return (result.rowCount ?? 0) > 0;
};

/** Эпизод варианта перепрогона. Прибор номером строки, как у живых алармов. */
export interface ReplayEpisodeRow {
  readonly variant: ReplayVariant;
  readonly deviceId: number;
  readonly metricKey: string;
  readonly mode: DeviceMode;
  readonly severity: Severity;
  readonly boundary: 'min' | 'max';
  readonly value: number | null;
  readonly threshold: number | null;
  readonly raisedAt: string;
  readonly clearedAt: string | null;
  readonly clearedValue: number | null;
}

/**
 * Эпизоды прогона одной пачкой, второй шаг транзакции итога после finishReplayRun. Пишутся,
 * только если прогон свой и не провален: в работе или уже завершён этой транзакцией (после
 * finishReplayRun он done). Проваленному по пульсу ничего не пишется, повтор эпизода ничего
 * не добавляет. Возвращает число вставленных строк.
 */
export const insertReplayEpisodes = async (
  client: pg.ClientBase,
  runId: string,
  owner: Pick<ReplayRunOwner, 'instanceId'>,
  rows: readonly ReplayEpisodeRow[],
): Promise<number> => {
  if (rows.length === 0) return 0;

  const result = await client.query(
    `INSERT INTO core.replay_alarm_episode (run_id, variant, device_id, metric_key, mode, severity,
       boundary, value, threshold, raised_at, cleared_at, cleared_value)
     SELECT r.id, e.variant, e.device_id, e.metric_key, e.mode, e.severity, e.boundary, e.value,
            e.threshold, e.raised_at, e.cleared_at, e.cleared_value
     FROM core.replay_run r
     CROSS JOIN unnest($3::text[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[],
       $9::float8[], $10::float8[], $11::timestamptz[], $12::timestamptz[], $13::float8[])
       AS e(variant, device_id, metric_key, mode, severity, boundary, value, threshold, raised_at,
         cleared_at, cleared_value)
     WHERE r.id = $1 AND r.instance_id = $2 AND r.status IN ('running', 'done')
     ON CONFLICT DO NOTHING`,
    [
      runId,
      owner.instanceId,
      rows.map((row) => row.variant),
      rows.map((row) => row.deviceId),
      rows.map((row) => row.metricKey),
      rows.map((row) => row.mode),
      rows.map((row) => row.severity),
      rows.map((row) => row.boundary),
      rows.map((row) => row.value),
      rows.map((row) => row.threshold),
      rows.map((row) => row.raisedAt),
      rows.map((row) => row.clearedAt),
      rows.map((row) => row.clearedValue),
    ],
  );

  return result.rowCount ?? 0;
};

/**
 * Оставляет последние keep завершённых прогонов, эпизоды удаляются каскадом. Третий шаг
 * транзакции итога, после finishReplayRun и insertReplayEpisodes: только что завершённый прогон
 * уже виден как завершённый и остаётся. Активный прогон не трогается. Возвращает число удалённых.
 */
export const pruneReplayRuns = async (client: pg.ClientBase, keep: number): Promise<number> => {
  const result = await client.query(
    `DELETE FROM core.replay_run
     WHERE id IN (
       SELECT id FROM core.replay_run
       WHERE status IN ('done', 'failed')
       ORDER BY created_at DESC OFFSET $1
     )`,
    [keep],
  );

  return result.rowCount ?? 0;
};

/** Эпизоды обоих вариантов одной строки разницы. */
export type ReplayVariantEpisodes = Pick<ReplayEpisodesResponse, 'baseline' | 'patched'>;

/**
 * Эпизоды строки (прибор, метрика, режим) по вариантам, по времени подъёма. С пределом limit
 * в каждом варианте не больше limit первых эпизодов.
 */
export const loadReplayEpisodes = async (
  client: pg.ClientBase,
  runId: string,
  key: ReplayEpisodesQuery,
  limit?: number,
): Promise<ReplayVariantEpisodes> => {
  const result = await client.query<{
    variant: ReplayVariant;
    device_code: string;
    metric_key: string;
    mode: DeviceMode;
    severity: Severity;
    boundary: 'min' | 'max';
    value: number | null;
    threshold: number | null;
    raised_at: Date;
    cleared_at: Date | null;
    cleared_value: number | null;
  }>(
    `SELECT variant, device_code, metric_key, mode, severity, boundary,
            value, threshold, raised_at, cleared_at, cleared_value
     FROM (
       SELECT e.variant, d.code AS device_code, e.metric_key, e.mode, e.severity, e.boundary,
              e.value, e.threshold, e.raised_at, e.cleared_at, e.cleared_value,
              row_number() OVER (PARTITION BY e.variant ORDER BY e.raised_at) AS n
       FROM core.replay_alarm_episode e JOIN core.devices d ON d.id = e.device_id
       WHERE e.run_id = $1 AND d.code = $2 AND e.metric_key = $3 AND e.mode = $4
     ) ranked
     WHERE $5::integer IS NULL OR n <= $5::integer
     ORDER BY raised_at`,
    [runId, key.deviceCode, key.metricKey, key.mode, limit ?? null],
  );
  const episodes: ReplayVariantEpisodes = { baseline: [], patched: [] };

  for (const row of result.rows) {
    episodes[row.variant].push({
      deviceCode: row.device_code,
      metricKey: row.metric_key,
      mode: row.mode,
      severity: row.severity,
      boundary: row.boundary,
      value: row.value,
      threshold: row.threshold,
      raisedAt: row.raised_at.toISOString(),
      clearedAt: isoOrNull(row.cleared_at),
      clearedValue: row.cleared_value,
    });
  }

  return episodes;
};

/** Сводка эпизодов одной строки разницы без живых: счёт обоих вариантов, новые и пропавшие. */
export interface ReplayEpisodeSummaryRow {
  readonly deviceCode: string;
  readonly metricKey: string;
  readonly mode: DeviceMode;
  readonly baseline: number;
  readonly patched: number;
  readonly added: number;
  readonly removed: number;
}

/**
 * Сводка эпизодов прогона по строкам (прибор, метрика, режим) агрегатом в базе, без выгрузки
 * эпизодов. Пара эпизода это хотя бы один эпизод другого варианта той же строки, чей интервал
 * пересекается с его интервалом (касание тоже считается). Открытый эпизод тянется до конца окна
 * прогона. added это эпизоды «стало» без пары, removed эпизоды «было» без пары. Пересечение
 * ищется окнами по времени подъёма: самый поздний конец среди начатых раньше и самое раннее
 * начало среди начатых позже. Строки без эпизодов в сводку не попадают.
 */
export const loadReplayEpisodeSummary = async (
  client: pg.ClientBase,
  runId: string,
): Promise<ReplayEpisodeSummaryRow[]> => {
  const result = await client.query<{
    device_code: string;
    metric_key: string;
    mode: DeviceMode;
    baseline: string;
    patched: string;
    added: string;
    removed: string;
  }>(
    `SELECT d.code AS device_code, p.metric_key, p.mode,
            count(*) FILTER (WHERE p.variant = 'baseline') AS baseline,
            count(*) FILTER (WHERE p.variant = 'patched') AS patched,
            count(*) FILTER (WHERE p.variant = 'patched' AND NOT p.paired) AS added,
            count(*) FILTER (WHERE p.variant = 'baseline' AND NOT p.paired) AS removed
     FROM (
       SELECT w.device_id, w.metric_key, w.mode, w.variant,
              CASE w.variant
                WHEN 'baseline' THEN coalesce(w.patched_ended_earlier >= w.raised_at, false)
                  OR coalesce(w.patched_raised_later <= w.ended_at, false)
                ELSE coalesce(w.baseline_ended_earlier >= w.raised_at, false)
                  OR coalesce(w.baseline_raised_later <= w.ended_at, false)
              END AS paired
       FROM (
         SELECT e.device_id, e.metric_key, e.mode, e.variant, e.raised_at, e.ended_at,
                max(e.ended_at) FILTER (WHERE e.variant = 'baseline') OVER earlier
                  AS baseline_ended_earlier,
                max(e.ended_at) FILTER (WHERE e.variant = 'patched') OVER earlier
                  AS patched_ended_earlier,
                min(e.raised_at) FILTER (WHERE e.variant = 'baseline') OVER later
                  AS baseline_raised_later,
                min(e.raised_at) FILTER (WHERE e.variant = 'patched') OVER later
                  AS patched_raised_later
         FROM (
           SELECT a.device_id, a.metric_key, a.mode, a.variant, a.raised_at,
                  coalesce(a.cleared_at, r.to_ts) AS ended_at
           FROM core.replay_alarm_episode a JOIN core.replay_run r ON r.id = a.run_id
           WHERE a.run_id = $1
         ) e
         WINDOW by_key AS (PARTITION BY e.device_id, e.metric_key, e.mode
                           ORDER BY e.raised_at, e.variant),
                earlier AS (by_key ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
                later AS (by_key ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)
       ) w
     ) p JOIN core.devices d ON d.id = p.device_id
     GROUP BY d.code, p.metric_key, p.mode
     ORDER BY d.code, p.metric_key, p.mode`,
    [runId],
  );

  return result.rows.map((row) => ({
    deviceCode: row.device_code,
    metricKey: row.metric_key,
    mode: row.mode,
    baseline: Number(row.baseline),
    patched: Number(row.patched),
    added: Number(row.added),
    removed: Number(row.removed),
  }));
};

/** Окно и приборы, по которым считаются живые эпизоды. */
export interface LiveAlarmEpisodeWindow {
  readonly from: string;
  readonly to: string;
  readonly deviceCodes: readonly string[];
}

/** Сколько живых эпизодов поднялось в окне по ключу (прибор, метрика, режим). */
export interface LiveAlarmEpisodeCount {
  readonly deviceCode: string;
  readonly metricKey: string;
  readonly mode: DeviceMode;
  readonly episodes: number;
}

/**
 * Живые эпизоды, поднятые в окне [from, to): справочная цифра рядом с перепрогоном. Шлюз
 * передаёт фактическое покрытие прогона (coveredFrom, coveredTo), а не запрошенное окно.
 */
export const countLiveAlarmEpisodes = async (
  client: pg.ClientBase,
  window: LiveAlarmEpisodeWindow,
): Promise<LiveAlarmEpisodeCount[]> => {
  const result = await client.query<{
    device_code: string;
    metric_key: string;
    mode: DeviceMode;
    episodes: string;
  }>(
    `SELECT d.code AS device_code, e.metric_key, e.mode, count(*) AS episodes
     FROM core.alarm_events e JOIN core.devices d ON d.id = e.device_id
     WHERE e.occurred_at >= $1 AND e.occurred_at < $2 AND d.code = ANY($3::text[])
     GROUP BY d.code, e.metric_key, e.mode
     ORDER BY d.code, e.metric_key, e.mode`,
    [window.from, window.to, [...window.deviceCodes]],
  );

  return result.rows.map((row) => ({
    deviceCode: row.device_code,
    metricKey: row.metric_key,
    mode: row.mode,
    episodes: Number(row.episodes),
  }));
};
