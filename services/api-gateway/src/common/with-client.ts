import type pg from 'pg';

/** Соединение из пула на один запрос: клиент возвращается в пул при любом исходе. */
export const withClient = async <T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();

  try {
    return await work(client);
  } finally {
    client.release();
  }
};
