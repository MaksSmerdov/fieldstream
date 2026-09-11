import type pg from 'pg';

/** Роли базы: владелец схемы, писатель телеметрии и читатель для интерфейса. */
export const ROLES = Object.freeze({
  migrator: 'fs_migrator',
  ingest: 'fs_ingest',
  api: 'fs_api',
});

export interface RolePasswords {
  readonly migrator: string;
  readonly ingest: string;
  readonly api: string;
}

const BOOTSTRAP_LOCK = 'fieldstream.bootstrap';

/**
 * Роли, расширения и схемы. Выполняется суперпользователем перед миграциями и идемпотентен:
 * пароль из окружения применяется при каждом запуске, а не только на пустом томе,
 * как было бы со скриптом инициализации образа.
 */
export const bootstrapDatabase = async (
  client: pg.ClientBase,
  database: string,
  passwords: RolePasswords,
): Promise<void> => {
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [BOOTSTRAP_LOCK]);

  try {
    const roles: readonly (readonly [string, string])[] = [
      [ROLES.migrator, passwords.migrator],
      [ROLES.ingest, passwords.ingest],
      [ROLES.api, passwords.api],
    ];

    for (const [role, password] of roles) {
      const name = client.escapeIdentifier(role);
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (exists.rowCount === 0) await client.query(`CREATE ROLE ${name} LOGIN`);
      await client.query(
        `ALTER ROLE ${name} WITH LOGIN PASSWORD ${client.escapeLiteral(password)}`,
      );
    }

    const owner = client.escapeIdentifier(ROLES.migrator);
    await client.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
    await client.query('CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit');
    await client.query(`CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION ${owner}`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ts AUTHORIZATION ${owner}`);
    await client.query(
      `GRANT CONNECT ON DATABASE ${client.escapeIdentifier(database)} TO ${owner}, ` +
        `${client.escapeIdentifier(ROLES.ingest)}, ${client.escapeIdentifier(ROLES.api)}`,
    );
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [BOOTSTRAP_LOCK]);
  }
};
