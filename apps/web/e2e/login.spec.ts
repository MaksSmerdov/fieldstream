import { expect, test } from '@playwright/test';

const EMAIL = process.env['E2E_EMAIL'] ?? 'engineer@fieldstream.local';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'fieldstream';

test('вход открывает обзор, а стадии готовности стенда видны до входа', async ({ page }) => {
  await page.goto('/login');

  await expect(page.getByText('Вход в Fieldstream')).toBeVisible();
  await expect(page.getByText(/Стенд (готов|готовится)/)).toBeVisible();

  await page.getByLabel('Почта').fill(EMAIL);
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();

  await expect(page.getByRole('heading', { name: 'Обзор' })).toBeVisible();
});

/**
 * Выход это не закрытие вкладки: кука обновления живёт на сервере тридцать суток, и без
 * явного выхода следующий человек за тем же браузером продолжит чужую сессию.
 */
test('выход закрывает сессию, и обратно без пароля не попасть', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Почта').fill(EMAIL);
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Обзор' })).toBeVisible();

  await page.getByRole('button', { name: /Инженер|engineer/ }).click();
  await page.getByRole('menuitem', { name: 'Выйти' }).click();

  await expect(page.getByText('Вход в Fieldstream')).toBeVisible();

  await page.goto('/');
  await expect(page.getByText('Вход в Fieldstream')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Обзор' })).toBeHidden();
});
