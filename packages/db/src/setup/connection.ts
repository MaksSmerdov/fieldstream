/** Параметры подключения к базе без пароля в строке лога. */
export interface ConnectionTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
}

/** Строка подключения роли: пароль экранируется, спецсимволы не ломают URL. */
export const connectionUrl = (target: ConnectionTarget, user: string, password: string): string =>
  `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${target.host}:${String(target.port)}/${encodeURIComponent(target.database)}`;
