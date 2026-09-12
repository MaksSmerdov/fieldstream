import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/password.js';

describe('хеш пароля', () => {
  it('проверяется своим же хешем и не совпадает с чужим паролем', async () => {
    const stored = await hashPassword('правильный пароль лошадь батарейка');

    expect(await verifyPassword('правильный пароль лошадь батарейка', stored)).toBe(true);
    expect(await verifyPassword('правильный пароль лошадь батареика', stored)).toBe(false);
  });

  it('соль своя у каждого хеша: одинаковые пароли дают разные строки', async () => {
    const first = await hashPassword('одинаковый');
    const second = await hashPassword('одинаковый');

    expect(first).not.toBe(second);
    expect(await verifyPassword('одинаковый', second)).toBe(true);
  });

  /** Параметры лежат в строке, поэтому их можно поднять, не ломая заведённые пароли. */
  it('хранит параметры разбора рядом со значением', async () => {
    const stored = await hashPassword('пароль');

    expect(stored.split('$').slice(0, 4)).toEqual(['scrypt', '16384', '8', '1']);
  });

  it('испорченная строка хеша это отказ, а не исключение', async () => {
    expect(await verifyPassword('пароль', 'мусор')).toBe(false);
    expect(await verifyPassword('пароль', 'scrypt$16384$8$1$$')).toBe(false);
  });
});
