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
