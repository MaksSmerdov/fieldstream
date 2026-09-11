import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

/** Каталог SQL-миграций: лежит рядом с исходниками и с собранным пакетом. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

export interface MigrateOptions {
  readonly databaseUrl: string;
  readonly direction: 'up' | 'down';
  readonly count?: number;
  readonly log?: (message: string) => void;
}

/**
 * Миграции на чистом SQL. Каждая выполняется в своей транзакции, параллельный запуск
 * отсекается advisory lock, порядок файлов проверяется. Схемой владеет SQL, а не ORM:
 * гипертаблицы, агрегаты и политики TimescaleDB ни один ORM нормально не выражает.
 */
export const runMigrations = async (options: MigrateOptions): Promise<string[]> => {
  const applied = await runner({
    databaseUrl: options.databaseUrl,
    dir: MIGRATIONS_DIR,
    direction: options.direction,
    count: options.count ?? Number.POSITIVE_INFINITY,
    migrationsSchema: 'core',
    migrationsTable: 'schema_migrations',
    checkOrder: true,
    log: options.log ?? (() => undefined),
  });
  return applied.map((migration) => migration.name);
};
