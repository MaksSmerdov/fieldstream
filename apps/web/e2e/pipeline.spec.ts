import { expect, test } from '@playwright/test';
import { violationsOf } from './axe.js';

const EMAIL = process.env['E2E_EMAIL'] ?? 'engineer@fieldstream.local';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'fieldstream';

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Почта').fill(EMAIL);
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Обзор' })).toBeVisible();
  await page.getByRole('tab', { name: 'Конвейер' }).click();
  await expect(page.getByRole('heading', { name: 'Конвейер', level: 1 })).toBeVisible();
});

test('конвейер показывает группу процессора с участником и таблицу топиков', async ({ page }) => {
  const group = page.getByRole('region', { name: 'Группа fs-processor', exact: true });
  await expect(group).toBeVisible();

  const members = group.getByRole('list', { name: 'Участники группы', exact: true });
  await expect(members.getByRole('listitem').first()).toBeVisible();

  const topics = page.getByRole('region', { name: 'Таблица топиков', exact: true });
  await expect(topics.getByRole('columnheader', { name: 'Топик', exact: true })).toBeVisible();
  await expect(topics.getByRole('row', { name: /сырые кадры/ })).toBeVisible();
});

test('конвейер без нарушений доступности', async ({ page }) => {
  await expect(
    page.getByRole('region', { name: 'Группа fs-processor', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Таблица топиков', exact: true })).toBeVisible();

  expect(await violationsOf(page)).toEqual([]);
});
