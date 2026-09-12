import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const EMAIL = process.env['E2E_EMAIL'] ?? 'engineer@fieldstream.local';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'fieldstream';

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Почта').fill(EMAIL);
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Обзор' })).toBeVisible();
  await page.goto('/device/RC-101');
  await expect(page.getByRole('heading', { name: /Прибор RC-101/ })).toBeVisible();
});

test('экран прибора показывает значения по секциям и живой график', async ({ page }) => {
  await expect(page.getByRole('img', { name: /График прибора RC-101/ })).toBeVisible();
  await expect(page.getByText('Температуры', { exact: true })).toBeVisible();
  await expect(page.getByText('Температура подачи', { exact: true })).toHaveCount(2);
  await expect(page.getByText(/источник: сырые отсчёты/)).toBeVisible();
});

/**
 * Источник данных выбирает сервер, а не фронт: на длинном окне подпись обязана смениться
 * сама, иначе она рассказывает не о тех числах, которые нарисованы.
 */
test('длинное окно переключает источник на агрегат', async ({ page }) => {
  await expect(page.getByText(/источник: сырые отсчёты/)).toBeVisible();

  await page.getByRole('button', { name: 'неделя' }).click();

  await expect(page.getByText(/источник: минутный агрегат/)).toBeVisible();
  await expect(page.getByRole('img', { name: /График прибора RC-101 за неделя/ })).toBeVisible();
});

/** Закрашенные точки канвы: пустой график отличается от нарисованного только этим. */
const inkOf = async (page: Page): Promise<number> =>
  page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const context = canvas?.getContext('2d') ?? null;
    if (canvas === null || context === null) return 0;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);

    let painted = 0;
    for (let index = 3; index < data.length; index += 64) {
      if ((data[index] ?? 0) > 0) painted += 1;
    }

    return painted;
  });

/**
 * Цвета осей уезжают на канву, поэтому при смене темы график пересоздаётся. Пересозданный
 * график обязан родиться сразу с данными: иначе он остаётся пустым до следующего обновления,
 * а на суточном окне это минуты пустоты.
 */
test('смена темы не оставляет график пустым', async ({ page }) => {
  await expect(page.getByRole('img', { name: /График прибора RC-101/ })).toBeVisible();
  expect(await inkOf(page)).toBeGreaterThan(100);

  await page.getByRole('button', { name: 'Светлая тема' }).click();

  await expect.poll(async () => inkOf(page)).toBeGreaterThan(100);
});
