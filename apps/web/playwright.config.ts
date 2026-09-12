import { defineConfig, devices } from '@playwright/test';

/**
 * Сценарии идут против живого стека: интерфейс проверяется вместе со шлюзом, брокером и базой,
 * иначе проверка превращается в тест разметки. По умолчанию это стенд целиком, поднятый одной
 * командой, а для дев-сервера адрес задаётся переменной: E2E_BASE_URL=http://127.0.0.1:5173.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  // Канал берётся из окружения: на машине разработчика подходит установленный Chrome,
  // в сборочной среде это скачанный chromium, и скачивать браузер ради локального прогона незачем
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: process.env['E2E_CHANNEL'] ?? 'chrome' },
    },
  ],
});
