import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { violationsOf } from './axe.js';

const EMAIL = process.env['E2E_EMAIL'] ?? 'engineer@fieldstream.local';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'fieldstream';

const signIn = async (page: Page): Promise<void> => {
  await page.goto('/login');
  await page.getByLabel('Почта').fill(EMAIL);
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Обзор' })).toBeVisible();
};

test('вход и панель готовности без нарушений доступности', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();

  expect(await violationsOf(page)).toEqual([]);
});

test('обзор без нарушений доступности', async ({ page }) => {
  await signIn(page);

  expect(await violationsOf(page)).toEqual([]);
});

test('прибор без нарушений доступности на всех вкладках', async ({ page }) => {
  await signIn(page);
  await page.goto('/device/RC-101');
  await expect(page.getByRole('heading', { name: /Прибор RC-101/ })).toBeVisible();
  expect(await violationsOf(page)).toEqual([]);

  await page.getByRole('tab', { name: 'Уставки' }).click();
  await expect(page.getByText('Уставки по режимам')).toBeVisible();
  expect(await violationsOf(page)).toEqual([]);

  await page.getByRole('tab', { name: 'Карта регистров' }).click();
  await expect(page.getByText(/запросов:/)).toBeVisible();
  expect(await violationsOf(page)).toEqual([]);
});

test('лента алармов без нарушений доступности', async ({ page }) => {
  await signIn(page);
  await page.goto('/alarms');
  await expect(page.getByRole('heading', { name: 'Алармы' })).toBeVisible();

  expect(await violationsOf(page)).toEqual([]);
});
