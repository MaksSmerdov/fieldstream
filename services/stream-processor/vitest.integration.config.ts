import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
});
