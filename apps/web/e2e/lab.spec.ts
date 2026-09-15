import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { scenariosResponseSchema } from '@fieldstream/contracts';

const EMAIL = process.env['E2E_EMAIL'] ?? 'engineer@fieldstream.local';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'fieldstream';

const SCENARIO_TITLES = [
  'Мусор в кадре',
  'Мёртвый прибор',
  'Отказ шлюза',
  'Обрыв линии',
  'Тихая ночная оттайка',
  'Температура за шкалой',
] as const;

const OUTCOME_TEXT = { passed: 'прошёл', failed: 'провален' } as const;

/** Нарушения доступности на живом экране по тем же правилам, что и у остальных экранов. */
const violationsOf = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'без оценки'}): ${violation.help}, узлов ${String(violation.nodes.length)}`,
  );
};

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Почта').fill(EMAIL);
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Обзор' })).toBeVisible();
  await page.getByRole('tab', { name: 'Отказы' }).click();
  await expect(page.getByRole('heading', { name: 'Отказы', exact: true })).toBeVisible();
});

test('отказы показывают снимки линий и приборы защиты выбранного прибора', async ({ page }) => {
  const chaos = page.getByRole('region', { name: 'Панель хаоса', exact: true });
  await expect(chaos).toBeVisible();
  await expect(chaos.getByRole('region', { name: /^Линия L\d+$/ }).first()).toBeVisible();

  await chaos.getByRole('button', { name: /^RC-102\b/ }).click();
  await expect(chaos.getByRole('button', { name: /^RC-102\b/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  const instruments = page.getByRole('region', { name: /^Прибор RC-102 на линии L\d+$/ });
  await expect(instruments).toBeVisible();
  await expect(instruments.getByText(/^снимок .+ назад · такт опроса/)).toBeVisible();
  for (const heading of ['Переподключение порта', 'Сторож обхода', 'Время ответа']) {
    await expect(instruments.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
});

test('шесть сценариев стенда, бейджи прогонов из CI видны', async ({ page }) => {
  const scenarios = page.getByRole('region', { name: 'Сценарии', exact: true });
  await expect(scenarios.getByRole('article')).toHaveCount(SCENARIO_TITLES.length);
  for (const title of SCENARIO_TITLES) {
    await expect(scenarios.getByRole('article', { name: title, exact: true })).toBeVisible();
  }

  const response = await page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === '/api/scenarios' &&
      candidate.request().method() === 'GET' &&
      candidate.ok(),
  );
  const listed = scenariosResponseSchema.parse(await response.json());
  expect(listed.scenarios).toHaveLength(SCENARIO_TITLES.length);

  for (const scenario of listed.scenarios) {
    const last = scenario.lastRun;
    if (last === null || last.source !== 'ci') continue;
    if (last.status !== 'passed' && last.status !== 'failed') continue;

    const card = scenarios.getByRole('article', { name: scenario.title, exact: true });
    await expect(card.getByText(OUTCOME_TEXT[last.status], { exact: true })).toBeVisible();
    await expect(card.getByText(/из CI/)).toBeVisible();
  }
});

test('отказы без нарушений доступности', async ({ page }) => {
  await expect(page.getByRole('region', { name: /^Прибор .+ на линии L\d+$/ })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Сценарии', exact: true }).getByRole('article'),
  ).toHaveCount(SCENARIO_TITLES.length);

  expect(await violationsOf(page)).toEqual([]);
});
