import { defineConfig, devices } from '@playwright/test';

/**
 * Сценарии идут против живого стека: интерфейс проверяется вместе со шлюзом, брокером и базой,
 * иначе проверка превращается в тест разметки. Адрес берётся из окружения, чтобы тот же набор
 * работал и против дев-сервера, и против контейнера с nginx.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:5173',
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
