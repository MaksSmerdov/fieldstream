import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { DeviceProfile, Stand } from '@fieldstream/contracts';
import { listPlanEntries } from '@fieldstream/device-profiles';

/** Описание метрики для интерфейса: как показывать значение из узкой таблицы чисел. */
export interface MetricDef {
  readonly profileKey: string;
  readonly metricKey: string;
  readonly label: string;
  readonly unit: string | null;
  readonly kind: 'number' | 'enum' | 'bits';
  readonly precision: number;
}

/** Адрес прибора в базе: по нему процессор кладёт строки телеметрии. */
export interface DeviceRef {
  readonly deviceId: number;
  readonly lineId: number;
  readonly code: string;
  readonly lineCode: string;
  /** Площадка нужна и для ключа подписки живого канала, и для ключа команд. */
  readonly siteCode: string;
}

/** Контрольная сумма описания профиля: по ней видно, что версию поменяли, не повысив номер. */
export const profileChecksum = (profile: DeviceProfile): string =>
  createHash('sha256').update(JSON.stringify(profile)).digest('hex');

/** Метрики профиля. Перечисление хранится кодом, слово аварий самим словом. */
export const metricDefsOf = (profile: DeviceProfile): MetricDef[] =>
  listPlanEntries(profile).map(({ param }) => ({
    profileKey: profile.profileKey,
    metricKey: param.key,
    label: param.label,
    unit: param.unit ?? null,
    kind: param.bits !== undefined ? 'bits' : param.enum !== undefined ? 'enum' : 'number',
    precision: param.precision,
  }));

/** Версия профиля неизменна: реплей истории должен уметь прочитать кадр той версией, которой его писали. */
const upsertProfile = async (client: pg.ClientBase, profile: DeviceProfile): Promise<void> => {
  const checksum = profileChecksum(profile);
  await client.query(
    `INSERT INTO core.device_profiles (profile_key, version, config, checksum)
     VALUES ($1, $2, $3, $4) ON CONFLICT (profile_key, version) DO NOTHING`,
    [profile.profileKey, profile.version, JSON.stringify(profile), checksum],
  );

  const stored = await client.query<{ checksum: string }>(
    'SELECT checksum FROM core.device_profiles WHERE profile_key = $1 AND version = $2',
    [profile.profileKey, profile.version],
  );
  if (stored.rows[0]?.checksum !== checksum) {
    throw new Error(
      `профиль ${profile.profileKey} версии ${String(profile.version)} изменён без повышения версии`,
    );
  }

  for (const def of metricDefsOf(profile)) {
    await client.query(
      `INSERT INTO core.metric_defs (profile_key, metric_key, label, unit, kind, precision)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (profile_key, metric_key) DO UPDATE
       SET label = EXCLUDED.label, unit = EXCLUDED.unit, kind = EXCLUDED.kind,
           precision = EXCLUDED.precision`,
      [def.profileKey, def.metricKey, def.label, def.unit, def.kind, def.precision],
    );
  }
};

/**
 * Переносит стенд в таблицы топологии одной транзакцией. Повторный запуск ничего не дублирует.
 * Режим плана чтения и признак включения линии это рабочее состояние, их синхронизация не трогает.
 */
export const syncTopology = async (
  client: pg.ClientBase,
  stand: Stand,
  profiles: readonly DeviceProfile[],
): Promise<void> => {
  await client.query('BEGIN');

  try {
    for (const profile of profiles) await upsertProfile(client, profile);

    for (const site of stand.sites) {
      await client.query(
        `INSERT INTO core.sites (code, name, timezone) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, timezone = EXCLUDED.timezone`,
        [site.code, site.name, site.timezone],
      );
    }

    for (const gateway of stand.gateways) {
      await client.query(
        `INSERT INTO core.gateways (site_id, code, host)
         SELECT id, $2, $3 FROM core.sites WHERE code = $1
         ON CONFLICT (code) DO UPDATE SET site_id = EXCLUDED.site_id, host = EXCLUDED.host`,
        [gateway.siteCode, gateway.code, gateway.host],
      );
    }

    for (const line of stand.lines) {
      await client.query(
        `INSERT INTO core.lines (gateway_id, code, port, baud, poll_interval_ms, request_timeout_ms)
         SELECT id, $2, $3, $4, $5, $6 FROM core.gateways WHERE code = $1
         ON CONFLICT (code) DO UPDATE
         SET gateway_id = EXCLUDED.gateway_id, port = EXCLUDED.port, baud = EXCLUDED.baud,
             poll_interval_ms = EXCLUDED.poll_interval_ms,
             request_timeout_ms = EXCLUDED.request_timeout_ms`,
        [
          line.gatewayCode,
          line.code,
          line.port,
          line.baud,
          line.pollIntervalMs,
          line.requestTimeoutMs,
        ],
      );
    }

    for (const device of stand.devices) {
      const profile = profiles.find((candidate) => candidate.profileKey === device.profileKey);
      if (profile === undefined) {
        throw new Error(`прибор ${device.code}: модель ${device.profileKey} не передана`);
      }
      await client.query(
        `INSERT INTO core.devices (line_id, code, profile_key, profile_version, slave_id, label)
         SELECT id, $2, $3, $4, $5, $6 FROM core.lines WHERE code = $1
         ON CONFLICT (code) DO UPDATE
         SET line_id = EXCLUDED.line_id, profile_key = EXCLUDED.profile_key,
             profile_version = EXCLUDED.profile_version, slave_id = EXCLUDED.slave_id,
             label = EXCLUDED.label`,
        [
          device.lineCode,
          device.code,
          profile.profileKey,
          profile.version,
          device.slaveId,
          `${profile.label} ${device.code}`,
        ],
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
};

/** Приборы с их идентификаторами в базе, по коду прибора. */
export const loadDeviceRefs = async (client: pg.ClientBase): Promise<Map<string, DeviceRef>> => {
  const result = await client.query<{
    device_id: number;
    line_id: number;
    code: string;
    line_code: string;
    site_code: string;
  }>(
    `SELECT d.id AS device_id, d.line_id, d.code, l.code AS line_code, s.code AS site_code
     FROM core.devices d
     JOIN core.lines l ON l.id = d.line_id
     JOIN core.gateways g ON g.id = l.gateway_id
     JOIN core.sites s ON s.id = g.site_id`,
  );

  return new Map(
    result.rows.map((row) => [
      row.code,
      {
        deviceId: row.device_id,
        lineId: row.line_id,
        code: row.code,
        lineCode: row.line_code,
        siteCode: row.site_code,
      },
    ]),
  );
};
