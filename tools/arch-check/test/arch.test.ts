import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Прогоняет dependency-cruiser и возвращает его отчёт. */
const runCruiser = (): { summary: { error: number; violations: unknown[] } } => {
  const out = execFileSync(
    'npx',
    [
      'depcruise',
      'packages',
      'services',
      'apps',
      '--config',
      '.dependency-cruiser.cjs',
      '--output-type',
      'json',
    ],
    { cwd: repoRoot, encoding: 'utf8', shell: true, maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(out) as { summary: { error: number; violations: unknown[] } };
};

describe('границы зависимостей', () => {
  it('ни одно архитектурное правило не нарушено', () => {
    const report = runCruiser();
    expect(report.summary.violations).toEqual([]);
    expect(report.summary.error).toBe(0);
  });
});
