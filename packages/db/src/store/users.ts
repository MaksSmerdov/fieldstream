import type pg from 'pg';
import { moduleIdSchema } from '@fieldstream/contracts';
import type { ModuleId, Role } from '@fieldstream/contracts';
import { hashPassword } from '@fieldstream/domain';

/** Пользователь с личными правами: роль задаёт основу, разрешения и запреты правят её. */
export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly disabled: boolean;
  readonly passwordHash: string;
  readonly grants: readonly ModuleId[];
  readonly denies: readonly ModuleId[];
}

/** Заводимый пользователь стенда. */
export interface DemoUser {
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly password: string;
}

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly role: Role;
  readonly disabled: boolean;
  readonly password_hash: string;
  readonly grants: string[] | null;
  readonly denies: string[] | null;
}

/** Имена модулей из базы проверяются схемой: лишнее в таблице прав не должно влиять на доступ. */
const modulesOf = (values: readonly string[] | null): ModuleId[] =>
  (values ?? []).flatMap((value) => {
    const parsed = moduleIdSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });

const toRecord = (row: UserRow): UserRecord => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  role: row.role,
  disabled: row.disabled,
  passwordHash: row.password_hash,
  grants: modulesOf(row.grants),
  denies: modulesOf(row.denies),
});

const USER_QUERY = `
  SELECT u.id, u.email, u.display_name, u.role, u.disabled, u.password_hash,
         array_remove(array_agg(p.module_id) FILTER (WHERE p.effect = 'grant'), NULL) AS grants,
         array_remove(array_agg(p.module_id) FILTER (WHERE p.effect = 'deny'), NULL) AS denies
  FROM core.users u
  LEFT JOIN core.user_permissions p ON p.user_id = u.id`;

/** Пользователь по почте. Регистр почты не различается: уникальный индекс построен так же. */
export const loadUserByEmail = async (
  client: pg.ClientBase,
  email: string,
): Promise<UserRecord | null> => {
  const result = await client.query<UserRow>(
    `${USER_QUERY} WHERE lower(u.email) = lower($1) GROUP BY u.id`,
    [email],
  );
  const row = result.rows[0];
  return row === undefined ? null : toRecord(row);
};

export const loadUserById = async (
  client: pg.ClientBase,
  id: string,
): Promise<UserRecord | null> => {
  const result = await client.query<UserRow>(`${USER_QUERY} WHERE u.id = $1 GROUP BY u.id`, [id]);
  const row = result.rows[0];
  return row === undefined ? null : toRecord(row);
};

/**
 * Пользователи стенда. Заводятся один раз: смена пароля в интерфейсе переживает
 * перезапуск, потому что уже заведённая запись не трогается.
 */
export const seedDemoUsers = async (
  client: pg.ClientBase,
  users: readonly DemoUser[],
): Promise<number> => {
  let created = 0;

  for (const user of users) {
    const exists = await client.query('SELECT 1 FROM core.users WHERE lower(email) = lower($1)', [
      user.email,
    ]);
    if (exists.rowCount !== 0) continue;

    await client.query(
      `INSERT INTO core.users (email, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4)`,
      [user.email, await hashPassword(user.password), user.displayName, user.role],
    );
    created += 1;
  }

  return created;
};
