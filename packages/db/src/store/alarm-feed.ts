import type pg from 'pg';
import type {
  AlarmListItem,
  AlarmRuleChange,
  AlarmRuleUpdate,
  AlarmRuleView,
  AlarmsQuery,
} from '@fieldstream/contracts';
import type { AlarmRuleAuditEntry } from '@fieldstream/contracts';
import { ruleDiff } from '@fieldstream/domain';

interface FeedRow {
  readonly id: string;
  readonly device_code: string;
  readonly device_label: string;
  readonly metric_key: string;
  readonly mode: AlarmRuleView['mode'];
  readonly severity: AlarmRuleView['severity'];
  readonly boundary: 'min' | 'max';
  readonly value: number | null;
  readonly threshold: number | null;
  readonly occurred_at: Date;
  readonly cleared_at: Date | null;
  readonly cleared_value: number | null;
  readonly acked_by: string | null;
  readonly acked_at: Date | null;
}

const toItem = (row: FeedRow): AlarmListItem => ({
  id: row.id,
  deviceCode: row.device_code,
  deviceLabel: row.device_label,
  metricKey: row.metric_key,
  mode: row.mode,
  severity: row.severity,
  boundary: row.boundary,
  value: row.value,
  threshold: row.threshold,
  occurredAt: row.occurred_at.toISOString(),
  clearedAt: row.cleared_at === null ? null : row.cleared_at.toISOString(),
  clearedValue: row.cleared_value,
  ackedBy: row.acked_by,
  ackedAt: row.acked_at === null ? null : row.acked_at.toISOString(),
  active: row.cleared_at === null,
});

/** Курсор это время и идентификатор последней строки: пара уникальна, страница не двоится. */
export const encodeAlarmCursor = (item: AlarmListItem): string =>
  Buffer.from(`${item.occurredAt}|${item.id}`, 'utf8').toString('base64url');

const decodeCursor = (cursor: string): { occurredAt: string; id: string } | null => {
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const occurredAt = parts[0];
  const id = parts[1];
  if (parts.length !== 2 || occurredAt === undefined || id === undefined) return null;
  if (Number.isNaN(Date.parse(occurredAt))) return null;

  return { occurredAt, id };
};

export interface AlarmPage {
  readonly items: AlarmListItem[];
  readonly nextCursor: string | null;
}

/**
 * Лента алармов от свежих к старым. Фильтры складываются, страница берётся на одну строку
 * длиннее запрошенной: так видно, есть ли продолжение, без отдельного счётного запроса.
 */
export const listAlarms = async (client: pg.ClientBase, query: AlarmsQuery): Promise<AlarmPage> => {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (condition: string, value: unknown): void => {
    params.push(value);
    conditions.push(condition.replace('$?', `$${String(params.length)}`));
  };

  if (query.state === 'active') conditions.push('e.cleared_at IS NULL');
  if (query.state === 'cleared') conditions.push('e.cleared_at IS NOT NULL');
  if (query.severity !== undefined) add('e.severity = $?', query.severity);
  if (query.device !== undefined) add('d.code = $?', query.device);
  if (query.from !== undefined) add('e.occurred_at >= $?', query.from);
  if (query.to !== undefined) add('e.occurred_at < $?', query.to);

  if (query.cursor !== undefined) {
    const cursor = decodeCursor(query.cursor);
    if (cursor === null) throw new Error('курсор испорчен');
    params.push(cursor.occurredAt, cursor.id);
    conditions.push(
      `(e.occurred_at, e.id) < ($${String(params.length - 1)}::timestamptz, $${String(params.length)}::uuid)`,
    );
  }

  params.push(query.limit + 1);
  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  const result = await client.query<FeedRow>(
    `SELECT e.id, d.code AS device_code, d.label AS device_label, e.metric_key, e.mode,
            e.severity, e.boundary, e.value, e.threshold, e.occurred_at, e.cleared_at,
            e.cleared_value, e.acked_by, e.acked_at
     FROM core.alarm_events e JOIN core.devices d ON d.id = e.device_id
     ${where}
     ORDER BY e.occurred_at DESC, e.id DESC
     LIMIT $${String(params.length)}`,
    params,
  );

  const items = result.rows.slice(0, query.limit).map(toItem);
  const hasMore = result.rows.length > query.limit;
  const last = items[items.length - 1];

  return {
    items,
    nextCursor: hasMore && last !== undefined ? encodeAlarmCursor(last) : null,
  };
};

/** Подтверждение аларма. Повторное подтверждение не переписывает того, кто это сделал первым. */
export const ackAlarm = async (
  client: pg.ClientBase,
  id: string,
  ackedBy: string,
  ackedAt: string,
): Promise<AlarmListItem | null> => {
  await client.query(
    `UPDATE core.alarm_events SET acked_by = $2, acked_at = $3
     WHERE id = $1 AND acked_at IS NULL`,
    [id, ackedBy, ackedAt],
  );

  const result = await client.query<FeedRow>(
    `SELECT e.id, d.code AS device_code, d.label AS device_label, e.metric_key, e.mode,
            e.severity, e.boundary, e.value, e.threshold, e.occurred_at, e.cleared_at,
            e.cleared_value, e.acked_by, e.acked_at
     FROM core.alarm_events e JOIN core.devices d ON d.id = e.device_id
     WHERE e.id = $1`,
    [id],
  );
  const row = result.rows[0];

  return row === undefined ? null : toItem(row);
};

interface RuleRow {
  readonly metric_key: string;
  readonly mode: AlarmRuleView['mode'];
  readonly min_value: number | null;
  readonly max_value: number | null;
  readonly hysteresis: number;
  readonly debounce_cycles: number;
  readonly severity: AlarmRuleView['severity'];
  readonly enabled: boolean;
  readonly updated_by: string | null;
  readonly updated_at: Date;
}

const toView = (row: RuleRow): AlarmRuleView => ({
  metricKey: row.metric_key,
  mode: row.mode,
  minValue: row.min_value,
  maxValue: row.max_value,
  hysteresis: row.hysteresis,
  debounceCycles: row.debounce_cycles,
  severity: row.severity,
  enabled: row.enabled,
  updatedBy: row.updated_by,
  updatedAt: row.updated_at.toISOString(),
});

const RULES_QUERY = `
  SELECT r.metric_key, r.mode, r.min_value, r.max_value, r.hysteresis, r.debounce_cycles,
         r.severity, r.enabled, r.updated_by, r.updated_at
  FROM core.alarm_rules r JOIN core.devices d ON d.id = r.device_id
  WHERE d.code = $1 ORDER BY r.metric_key, r.mode`;

/** Уставки одного прибора вместе с тем, кто и когда их правил. */
export const loadDeviceAlarmRules = async (
  client: pg.ClientBase,
  deviceCode: string,
): Promise<AlarmRuleView[]> => {
  const result = await client.query<RuleRow>(RULES_QUERY, [deviceCode]);

  return result.rows.map(toView);
};

/** Поля, которые видно в истории правок. Сравнение общее с журналом: расходиться им нельзя. */
const changedFields = (before: AlarmRuleView | undefined, after: AlarmRuleUpdate): string[] =>
  ruleDiff(before, after).map((change) => change.field);

export interface AlarmRulesUpdateResult {
  readonly changes: AlarmRuleChange[];
  readonly rules: AlarmRuleView[];
}

/**
 * Правка уставок одной транзакцией вместе с историей. Запись в историю это не побочный эффект
 * где-то рядом, а часть той же транзакции: иначе правка и её след могли бы разойтись.
 */
export const updateDeviceAlarmRules = async (
  client: pg.PoolClient,
  deviceCode: string,
  updates: readonly AlarmRuleUpdate[],
  changedBy: string,
  changedAt: string,
): Promise<AlarmRulesUpdateResult | null> => {
  await client.query('BEGIN');

  try {
    const device = await client.query<{ id: number }>(
      'SELECT id FROM core.devices WHERE code = $1',
      [deviceCode],
    );
    const deviceId = device.rows[0]?.id;
    if (deviceId === undefined) {
      await client.query('ROLLBACK');
      return null;
    }

    const before = new Map(
      (await client.query<RuleRow>(RULES_QUERY, [deviceCode])).rows
        .map(toView)
        .map((rule) => [`${rule.metricKey}|${rule.mode}`, rule]),
    );
    const changes: AlarmRuleChange[] = [];

    for (const update of updates) {
      const previous = before.get(`${update.metricKey}|${update.mode}`);
      const fields = changedFields(previous, update);
      if (previous !== undefined && fields.length === 0) continue;

      await client.query(
        `INSERT INTO core.alarm_rules (device_id, metric_key, mode, min_value, max_value,
           hysteresis, debounce_cycles, severity, enabled, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (device_id, metric_key, mode) DO UPDATE
         SET min_value = EXCLUDED.min_value, max_value = EXCLUDED.max_value,
             hysteresis = EXCLUDED.hysteresis, debounce_cycles = EXCLUDED.debounce_cycles,
             severity = EXCLUDED.severity, enabled = EXCLUDED.enabled,
             updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [
          deviceId,
          update.metricKey,
          update.mode,
          update.minValue,
          update.maxValue,
          update.hysteresis,
          update.debounceCycles,
          update.severity,
          update.enabled,
          changedBy,
          changedAt,
        ],
      );

      await client.query(
        `INSERT INTO core.alarm_rule_audit (rule_id, device_id, metric_key, mode, changed_by,
           changed_at, diff)
         SELECT r.id, $1, $2, $3, $4, $5, $6
         FROM core.alarm_rules r
         WHERE r.device_id = $1 AND r.metric_key = $2 AND r.mode = $3`,
        [
          deviceId,
          update.metricKey,
          update.mode,
          changedBy,
          changedAt,
          JSON.stringify({ before: previous ?? null, after: update }),
        ],
      );

      changes.push({
        metricKey: update.metricKey,
        mode: update.mode,
        created: previous === undefined,
        changed: fields,
      });
    }

    const rules = (await client.query<RuleRow>(RULES_QUERY, [deviceCode])).rows.map(toView);
    await client.query('COMMIT');

    return { changes, rules };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
};

interface AuditRow {
  readonly id: string;
  readonly metric_key: string;
  readonly mode: AlarmRuleView['mode'];
  readonly changed_by: string;
  readonly changed_at: Date;
  readonly diff: {
    readonly before: Record<string, unknown> | null;
    readonly after: Record<string, unknown>;
  };
}

/**
 * Журнал правок уставок прибора. Разница полей считается при чтении из сохранённых снимков
 * «до» и «после»: так журнал не зависит от того, какие поля умел сравнивать код в день правки.
 */
export const loadAlarmRuleAudit = async (
  client: pg.ClientBase,
  deviceCode: string,
  limit: number,
): Promise<AlarmRuleAuditEntry[]> => {
  const result = await client.query<AuditRow>(
    `SELECT a.id::text AS id, a.metric_key, a.mode, a.changed_by, a.changed_at, a.diff
     FROM core.alarm_rule_audit a
     JOIN core.devices d ON d.id = a.device_id
     WHERE d.code = $1
     ORDER BY a.changed_at DESC, a.id DESC
     LIMIT $2`,
    [deviceCode, limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    metricKey: row.metric_key,
    mode: row.mode,
    changedBy: row.changed_by,
    changedAt: row.changed_at.toISOString(),
    created: row.diff.before === null,
    fields: ruleDiff(row.diff.before, row.diff.after),
  }));
};
