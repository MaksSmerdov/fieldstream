import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Дев-сервер ходит в шлюз напрямую. В контейнере фронт и API стоят за одним nginx,
 * поэтому и здесь адрес один: разница между разработкой и стендом не должна лезть в код.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    // Адрес задан явно: по умолчанию vite слушает только ::1, и всё, что ходит на 127.0.0.1,
    // включая сценарии Playwright, получает отказ соединения без внятной причины
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: process.env['VITE_API_TARGET'] ?? 'http://127.0.0.1:8093',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
