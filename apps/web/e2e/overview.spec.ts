import { expect, test } from '@playwright/test';

const EMAIL = process.env['E2E_EMAIL'] ?? 'engineer@fieldstream.local';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'fieldstream';

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Почта').fill(EMAIL);
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Обзор' })).toBeVisible();
});

test('обзор показывает стенд, сводку и живые значения', async ({ page }) => {
  await expect(page.getByText('SITE-A')).toBeVisible();
  await expect(page.getByText('приборов')).toBeVisible();

  const devices = page.getByRole('link', { name: /^(RC|PM)-\d+$/ });
  await expect(devices.first()).toBeVisible();
  expect(await devices.count()).toBeGreaterThan(5);

  // Подпись сводки, а не чипы приборов: «в сети» встречается и там, и там
  await expect(page.getByText('в сети', { exact: true }).last()).toBeVisible();
});

test('переход на прибор открывает его экран', async ({ page }) => {
  await page.getByRole('link', { name: 'RC-101' }).click();

  await expect(page.getByRole('heading', { name: /Прибор RC-101/ })).toBeVisible();
});
