import { expect, test } from '@playwright/test';

const EMAIL = process.env['E2E_EMAIL'] ?? 'engineer@fieldstream.local';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'fieldstream';

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Почта').fill(EMAIL);
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Обзор' })).toBeVisible();
  await page.goto('/alarms');
  await expect(page.getByRole('heading', { name: 'Алармы' })).toBeVisible();
});

test('лента показывает эпизоды со значением и уставкой', async ({ page }) => {
  await expect(page.getByText(/выше уставки|ниже уставки/).first()).toBeVisible();
  await expect(page.getByText(/показано \d+ эпизод/)).toBeVisible();
});

/** Ссылка на отфильтрованную ленту должна открывать у соседа ровно то же самое. */
test('фильтр по прибору попадает в адрес и сужает ленту', async ({ page }) => {
  await page.goto('/alarms?device=RC-103');

  const links = page.getByRole('link', { name: /^(RC|PM)-\d+$/ });
  await expect(links.first()).toBeVisible();
  const codes = await links.allInnerTexts();
  expect(new Set(codes)).toEqual(new Set(['RC-103']));
});

/**
 * Отметка ставится до ответа сервера, поэтому важно, что она не только появилась на экране,
 * но и пережила перезагрузку: иначе оптимизм остался бы враньём.
 */
test('подтверждение остаётся после перезагрузки страницы', async ({ page }) => {
  const unacked = page
    .locator('[data-alarm]')
    .filter({ has: page.getByRole('button', { name: 'Подтвердить' }) })
    .first();
  await expect(unacked).toBeVisible();

  // Строка перестаёт подходить под фильтр сразу после подтверждения, поэтому дальше
  // она ищется по признаку эпизода, а не по наличию кнопки
  const id = String(await unacked.getAttribute('data-alarm'));
  const row = page.locator(`[data-alarm="${id}"]`);

  await row.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(row.getByText(EMAIL)).toBeVisible();

  await page.reload();
  await expect(page.locator(`[data-alarm="${id}"]`).getByText(EMAIL)).toBeVisible();
});
