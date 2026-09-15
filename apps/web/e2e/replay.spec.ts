import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, Response } from '@playwright/test';
import {
  FINISHED_REPLAY_RUN_STATUSES,
  replayRunSchema,
  replayRunsResponseSchema,
} from '@fieldstream/contracts';
import type { ReplayRun, ReplayRunStatus } from '@fieldstream/contracts';

const EMAIL = process.env['E2E_EMAIL'] ?? 'engineer@fieldstream.local';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'fieldstream';

/** Сколько ждать итога перепрогона: окно в пятнадцать минут процессор читает за секунды. */
const RUN_LIMIT_MS = 240_000;

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

/**
 * Итог прогона из ответа опроса хода или перечитанного списка; null, если ответ не про этот
 * прогон или прогон ещё идёт. Токен живёт в памяти вкладки, поэтому итог ловится в ответах экрана.
 */
const finishedStatusOf = async (
  response: Response,
  runId: string,
): Promise<ReplayRunStatus | null> => {
  const { pathname } = new URL(response.url());
  let found: ReplayRun | undefined;
  if (pathname === `/api/replay-runs/${runId}`) {
    found = replayRunSchema.parse(await response.json());
  } else if (pathname === '/api/replay-runs') {
    const listed = replayRunsResponseSchema.parse(await response.json());
    found = listed.runs.find((item) => item.id === runId);
  }

  return found !== undefined && FINISHED_REPLAY_RUN_STATUSES.includes(found.status)
    ? found.status
    : null;
};

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Почта').fill(EMAIL);
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Обзор' })).toBeVisible();
  await page.getByRole('tab', { name: 'Перепрогон' }).click();
  await expect(page.getByRole('heading', { name: 'Перепрогон', level: 1 })).toBeVisible();
});

test('инженер ставит перепрогон за последние 15 минут с примером правки и видит итог', async ({
  page,
}) => {
  test.setTimeout(RUN_LIMIT_MS * 2 + 60_000);

  const form = page.getByRole('region', { name: 'Новый перепрогон', exact: true });
  const example = form.getByRole('button', { name: 'Граница испарителя в оттайке +8' });
  await expect(example).toBeEnabled();
  await example.click();

  await expect(form.getByRole('button', { name: /^RC-101\b/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const patch = form.getByRole('group', { name: 'Правка 1', exact: true });
  await expect(patch.getByLabel('Верхняя граница')).toHaveValue('8');
  await expect(patch.getByText(/^сейчас /).first()).toBeVisible();

  await form.getByRole('button', { name: '15 мин', exact: true }).click();

  const submit = form.getByRole('button', { name: 'Поставить перепрогон' });
  await expect(submit).not.toHaveAttribute('aria-disabled', 'true', { timeout: RUN_LIMIT_MS });

  const accepted = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === '/api/replay-runs' &&
      candidate.request().method() === 'POST',
  );
  await submit.click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  const run = replayRunSchema.parse(await response.json());
  expect(Date.parse(run.to) - Date.parse(run.from)).toBe(900_000);

  const finished = page.waitForResponse(
    async (candidate) => {
      if (candidate.request().method() !== 'GET' || !candidate.ok()) return false;
      const status = await finishedStatusOf(candidate, run.id);
      return status !== null;
    },
    { timeout: RUN_LIMIT_MS },
  );
  await expect(page).toHaveURL(new RegExp(`[?&]run=${run.id}(&|$)`));
  expect(await finishedStatusOf(await finished, run.id)).toBe('done');

  const progress = page.getByRole('region', { name: 'Ход перепрогона', exact: true });
  await expect(progress.getByText('готово', { exact: true })).toBeVisible();

  const result = page.getByRole('region', { name: 'Разница срабатываний', exact: true });
  const table = result.getByRole('region', { name: 'Таблица разницы срабатываний', exact: true });
  const unchanged = result.getByText('Правка не изменила ни одного срабатывания', {
    exact: true,
  });
  const noFrames = result.getByText('В окне нет кадров', { exact: true });
  const noDeviceFrames = result.getByText('Кадров выбранных приборов в окне нет', { exact: true });
  await expect(table.or(unchanged).or(noFrames).or(noDeviceFrames)).toBeVisible();

  if (await table.isVisible()) {
    await expect(table.getByRole('columnheader', { name: 'Стало', exact: true })).toBeVisible();
    await expect(result.getByRole('img', { name: /^График RC-/ })).toBeVisible();
  }
});

test('перепрогон без нарушений доступности', async ({ page }) => {
  await expect(
    page
      .getByRole('region', { name: 'Новый перепрогон', exact: true })
      .getByRole('button', { name: /^RC-101\b/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Последние перепрогоны', exact: true }),
  ).toBeVisible();

  expect(await violationsOf(page)).toEqual([]);
});
