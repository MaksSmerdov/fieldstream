import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const EMAIL = process.env['E2E_EMAIL'] ?? 'engineer@fieldstream.local';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'fieldstream';
const DEVICE = 'RC-102';
const FIELD = `гистерезис supply_temp_c cooling`;

const openRules = async (page: Page): Promise<void> => {
  await page.goto(`/device/${DEVICE}`);
  await expect(page.getByRole('heading', { name: new RegExp(`Прибор ${DEVICE}`) })).toBeVisible();
  await page.getByRole('tab', { name: 'Уставки' }).click();
  await expect(page.getByText('Уставки по режимам')).toBeVisible();
};

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Почта').fill(EMAIL);
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Обзор' })).toBeVisible();
  await openRules(page);
});

test('уставки показаны по режимам: в оттайке границы шире', async ({ page }) => {
  const cooling = page.getByLabel('верхняя граница supply_temp_c cooling');
  const defrost = page.getByLabel('верхняя граница supply_temp_c defrost');

  await expect(cooling).toBeVisible();
  expect(Number(await cooling.inputValue())).toBeLessThan(Number(await defrost.inputValue()));
});

/**
 * Правка без видимого следа это ровно то, чего быть не должно: запись журнала появляется
 * в той же транзакции, что и сама уставка, и экран обязан её показать.
 */
test('правка уставки сохраняется и попадает в журнал правок', async ({ page }) => {
  const field = page.getByLabel(FIELD);
  const before = await field.inputValue();
  const after = String(Number(before) + 0.5);

  await field.fill(after);
  await page.getByRole('button', { name: /Сохранить/ }).click();

  await expect(page.getByText(/Сохранено 1 уставка/)).toBeVisible();
  await expect(page.getByText('Журнал правок')).toBeVisible();
  await expect(page.getByText(`гистерезис: ${before} → ${after}`).first()).toBeVisible();
  await expect(page.getByText(EMAIL).first()).toBeVisible();

  await page.reload();
  await page.getByRole('tab', { name: 'Уставки' }).click();
  await expect(page.getByLabel(FIELD)).toHaveValue(after);

  await page.getByLabel(FIELD).fill(before);
  await page.getByRole('button', { name: /Сохранить/ }).click();
  await expect(page.getByText(/Сохранено 1 уставка/)).toBeVisible();
});

/** Схема проверки на экране та же, что на сервере: экран не должен разрешать отказ шлюза. */
test('перевёрнутые границы объясняются на месте и сохранить нельзя', async ({ page }) => {
  await page.getByLabel('нижняя граница supply_temp_c cooling').fill('100');

  await expect(page.getByText(/нижняя граница должна быть меньше верхней/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Сохранить/ })).toBeDisabled();
});
