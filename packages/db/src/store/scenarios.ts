import type pg from 'pg';
import { z } from 'zod';
import { scenarioRunStepSchema } from '@fieldstream/contracts';
import type {
  DeviceMode,
  HealthReason,
  HealthStatus,
  ScenarioRun,
  ScenarioRunSource,
  ScenarioRunStatus,
  ScenarioRunStep,
} from '@fieldstream/contracts';
import { profileByKey } from '@fieldstream/device-profiles';

interface ScenarioRunRow {
  readonly id: string;
  readonly scenario: string;
  readonly title: string;
  readonly source: ScenarioRunSource;
  readonly requested_by: string;
  readonly status: ScenarioRunStatus;
  readonly steps: unknown;
  readonly error: string | null;
  readonly created_at: Date;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
}

const RUN_COLUMNS = `id, scenario, title, source, requested_by, status, steps, error, created_at,
  started_at, finished_at`;

const stepsSchema = z.array(scenarioRunStepSchema);

/** Шаги из jsonb: неразборчивая запись не роняет чтение прогона. */
const stepsOf = (value: unknown): ScenarioRunStep[] => {
  const parsed = stepsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
};

const isoOrNull = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

const toRun = (row: ScenarioRunRow): ScenarioRun => ({
  id: row.id,
  scenario: row.scenario,
  title: row.title,
  source: row.source,
  requestedBy: row.requested_by,
  status: row.status,
  steps: stepsOf(row.steps),
  error: row.error,
  createdAt: row.created_at.toISOString(),
  startedAt: isoOrNull(row.started_at),
  finishedAt: isoOrNull(row.finished_at),
});

/** Исполнитель прогона: экземпляр шлюза и момент его последнего пульса. */
export interface ScenarioRunOwner {
  readonly instanceId: string;
  readonly heartbeatAt: string;
}

/** Новый прогон: сценарий, кто и откуда запустил, план шагов и исполнитель. */
export interface ScenarioRunEntry {
  readonly scenario: string;
  readonly title: string;
  readonly source: ScenarioRunSource;
  readonly requestedBy: string;
  readonly steps: readonly ScenarioRunStep[];
  readonly owner: ScenarioRunOwner;
}

/** Итог постановки прогона: создан или стенд занят другим прогоном. */
export type CreateScenarioRunResult =
  | { readonly created: true; readonly run: ScenarioRun }
  | { readonly created: false; readonly active: ScenarioRun | null };

/** Идущий или ждущий прогон стенда. */
export const loadActiveScenarioRun = async (client: pg.ClientBase): Promise<ScenarioRun | null> => {
  const result = await client.query<ScenarioRunRow>(
    `SELECT ${RUN_COLUMNS} FROM core.scenario_run
     WHERE status IN ('queued', 'running')
     ORDER BY created_at DESC LIMIT 1`,
  );
  const row = result.rows[0];

  return row === undefined ? null : toRun(row);
};

/**
 * Ставит прогон в очередь. Уникальный индекс держит один активный прогон на стенд: занятый
 * стенд возвращается итогом с активным прогоном, а не исключением базы.
 */
export const createScenarioRun = async (
  client: pg.ClientBase,
  entry: ScenarioRunEntry,
): Promise<CreateScenarioRunResult> => {
  const result = await client.query<ScenarioRunRow>(
    `INSERT INTO core.scenario_run
       (scenario, title, source, requested_by, steps, instance_id, heartbeat_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT DO NOTHING
     RETURNING ${RUN_COLUMNS}`,
    [
      entry.scenario,
      entry.title,
      entry.source,
      entry.requestedBy,
      JSON.stringify(entry.steps),
      entry.owner.instanceId,
      entry.owner.heartbeatAt,
    ],
  );
  const row = result.rows[0];
  if (row !== undefined) return { created: true, run: toRun(row) };

  return { created: false, active: await loadActiveScenarioRun(client) };
};

/** Ход прогона: шаги и момент начала. */
export interface ScenarioRunProgress {
  readonly steps: readonly ScenarioRunStep[];
  readonly startedAt: string;
}

/**
 * Пишет ход прогона вместе с пульсом и переводит его в работу. false значит, что прогон уже
 * завершён или исполняет другой экземпляр: исполнение пора прервать.
 */
export const updateScenarioRunProgress = async (
  client: pg.ClientBase,
  id: string,
  owner: ScenarioRunOwner,
  progress: ScenarioRunProgress,
): Promise<boolean> => {
  const result = await client.query(
    `UPDATE core.scenario_run
     SET status = 'running', steps = $2::jsonb, started_at = coalesce(started_at, $3),
         heartbeat_at = $4
     WHERE id = $1 AND status IN ('queued', 'running') AND instance_id = $5`,
    [id, JSON.stringify(progress.steps), progress.startedAt, owner.heartbeatAt, owner.instanceId],
  );

  return (result.rowCount ?? 0) > 0;
};

/** Пульс исполнителя. false значит, что прогон уже не его: завершён или брошен по пульсу. */
export const touchScenarioRun = async (
  client: pg.ClientBase,
  id: string,
  owner: ScenarioRunOwner,
): Promise<boolean> => {
  const result = await client.query(
    `UPDATE core.scenario_run SET heartbeat_at = $2
     WHERE id = $1 AND status IN ('queued', 'running') AND instance_id = $3`,
    [id, owner.heartbeatAt, owner.instanceId],
  );

  return (result.rowCount ?? 0) > 0;
};

/** Итог прогона. */
export interface ScenarioRunOutcome {
  readonly status: 'passed' | 'failed';
  readonly steps: readonly ScenarioRunStep[];
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string;
}

/** Завершает прогон. Уже завершённый не переписывается: итог пишется один раз. */
export const finishScenarioRun = async (
  client: pg.ClientBase,
  id: string,
  outcome: ScenarioRunOutcome,
): Promise<boolean> => {
  const result = await client.query(
    `UPDATE core.scenario_run
     SET status = $2, steps = $3::jsonb, error = $4, started_at = coalesce(started_at, $5),
         finished_at = $6
     WHERE id = $1 AND status IN ('queued', 'running')`,
    [
      id,
      outcome.status,
      JSON.stringify(outcome.steps),
      outcome.error,
      outcome.startedAt,
      outcome.finishedAt,
    ],
  );

  return (result.rowCount ?? 0) > 0;
};

/** Последний прогон каждого сценария, у которого прогоны были. */
export const loadLastScenarioRuns = async (client: pg.ClientBase): Promise<ScenarioRun[]> => {
  const result = await client.query<ScenarioRunRow>(
    `SELECT DISTINCT ON (scenario) ${RUN_COLUMNS} FROM core.scenario_run
     ORDER BY scenario, created_at DESC`,
  );

  return result.rows.map(toRun);
};

export const loadScenarioRun = async (
  client: pg.ClientBase,
  id: string,
): Promise<ScenarioRun | null> => {
  const result = await client.query<ScenarioRunRow>(
    `SELECT ${RUN_COLUMNS} FROM core.scenario_run WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];

  return row === undefined ? null : toRun(row);
};

/** Какие прогоны считать брошенными: пульс старше staleBefore или исполнитель это instanceId. */
export interface StaleScenarioRunFilter {
  readonly staleBefore: string;
  readonly instanceId: string | null;
}

/**
 * Брошенные прогоны завершаются с ошибкой: исполнять их уже некому. Брошен прогон без пульса,
 * с пульсом старше staleBefore или прежнего процесса того же экземпляра. Шаг в работе
 * становится проваленным, не начатые пропущенными. Возвращает число завершённых.
 */
export const failStaleScenarioRuns = async (
  client: pg.ClientBase,
  filter: StaleScenarioRunFilter,
  error: string,
  finishedAt: string,
): Promise<number> => {
  const result = await client.query(
    `UPDATE core.scenario_run
     SET status = 'failed', error = $1, finished_at = $2,
         steps = coalesce(
           (SELECT jsonb_agg(
                     CASE step ->> 'status'
                       WHEN 'running' THEN step || jsonb_build_object(
                         'status', 'failed', 'finishedAt', $3::text, 'detail', $1::text)
                       WHEN 'pending' THEN step || jsonb_build_object('status', 'skipped')
                       ELSE step
                     END ORDER BY position)
            FROM jsonb_array_elements(steps) WITH ORDINALITY AS item(step, position)),
           '[]'::jsonb)
     WHERE status IN ('queued', 'running')
       AND (heartbeat_at IS NULL OR heartbeat_at < $4 OR instance_id = $5)`,
    [error, finishedAt, finishedAt, filter.staleBefore, filter.instanceId],
  );

  return result.rowCount ?? 0;
};

/** Здоровье и режим прибора для проб сценариев. */
export interface StandDeviceFact {
  readonly deviceCode: string;
  readonly profileKey: string;
  readonly status: HealthStatus;
  readonly reason: HealthReason;
  readonly mode: DeviceMode | null;
}

/** Режим сообщают модели с состоянием оттайки: по нему процессор и выводит режим. */
const reportsMode = (profileKey: string): boolean =>
  profileByKey(profileKey)?.sections.some((section) =>
    section.params.some((param) => param.key === 'defrost_state'),
  ) ?? false;

/**
 * Состояние всех приборов стенда. Прибор без строки состояния в неизвестном статусе, режим
 * у моделей без режима и у приборов без состояния не известен.
 */
export const loadStandDeviceFacts = async (client: pg.ClientBase): Promise<StandDeviceFact[]> => {
  const result = await client.query<{
    device_code: string;
    profile_key: string;
    status: HealthStatus | null;
    reason: HealthReason | null;
    mode: DeviceMode | null;
  }>(
    `SELECT d.code AS device_code, d.profile_key, s.status, s.reason, s.mode
     FROM core.devices d LEFT JOIN core.device_state s ON s.device_id = d.id
     ORDER BY d.code`,
  );

  return result.rows.map((row) => ({
    deviceCode: row.device_code,
    profileKey: row.profile_key,
    status: row.status ?? 'unknown',
    reason: row.reason ?? 'no_data',
    mode: reportsMode(row.profile_key) ? row.mode : null,
  }));
};

/** Активный аларм: эпизод без снятия. */
export interface ActiveAlarmFact {
  readonly deviceCode: string;
  readonly metricKey: string;
}

export const loadActiveAlarmFacts = async (client: pg.ClientBase): Promise<ActiveAlarmFact[]> => {
  const result = await client.query<{ device_code: string; metric_key: string }>(
    `SELECT d.code AS device_code, e.metric_key
     FROM core.alarm_events e JOIN core.devices d ON d.id = e.device_id
     WHERE e.cleared_at IS NULL
     ORDER BY d.code, e.metric_key`,
  );

  return result.rows.map((row) => ({ deviceCode: row.device_code, metricKey: row.metric_key }));
};

/** Число поднятых с момента since алармов по метрикам. */
export const countAlarmsRaisedSince = async (
  client: pg.ClientBase,
  since: string,
): Promise<Record<string, number>> => {
  const result = await client.query<{ metric_key: string; raised: string }>(
    `SELECT metric_key, count(*) AS raised FROM core.alarm_events
     WHERE occurred_at >= $1
     GROUP BY metric_key`,
    [since],
  );

  return Object.fromEntries(result.rows.map((row) => [row.metric_key, Number(row.raised)]));
};
