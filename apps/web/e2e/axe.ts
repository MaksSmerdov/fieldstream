import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/**
 * Нарушения доступности на живом экране. Проверка идёт в браузере, а не по разметке в тестах:
 * половина нарушений видна только с настоящими стилями, например контраст и порядок заголовков.
 * Набор правил один на все экраны, поэтому и живёт он в одном месте.
 */
export const violationsOf = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'без оценки'}): ${violation.help}, узлов ${String(violation.nodes.length)}`,
  );
};
