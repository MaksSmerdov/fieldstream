import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Параметры scrypt. Едут в самой строке хеша, поэтому их можно поднять позже,
 * не ломая уже заведённые пароли: проверка читает те значения, с которыми хеш считали.
 */
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLEL = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const ALGORITHM = 'scrypt';

const derive = (
  password: string,
  salt: Buffer,
  cost: number,
  blockSize: number,
  parallel: number,
  keyLength: number,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      keyLength,
      { N: cost, r: blockSize, p: parallel, maxmem: 256 * cost * blockSize },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });

/** Хеш пароля вместе с солью и параметрами в одной строке. */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, COST, BLOCK_SIZE, PARALLEL, KEY_LENGTH);

  return [
    ALGORITHM,
    COST,
    BLOCK_SIZE,
    PARALLEL,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
};

/** Проверка пароля. Сравнение постоянного времени: по длительности ответа подобрать хеш нельзя. */
export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return false;

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallel = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64url');
  const expected = Buffer.from(parts[5] ?? '', 'base64url');
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallel)) {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const key = await derive(password, salt, cost, blockSize, parallel, expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
};
