import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Физика досчитывается посекундно, и тесты прогоняют часы модельного времени.
    // Срока по умолчанию не хватает, когда пакеты идут параллельно на слабой машине
    testTimeout: 30_000,
  },
});
