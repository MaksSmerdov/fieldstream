import { createTheme } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';

/**
 * Тема как источник токенов. Переменные MUI выводятся в CSS, и стили на SCSS-модулях берут
 * те же цвета, что готовые компоненты.
 */
export const createAppTheme = (mode: 'light' | 'dark'): Theme =>
  createTheme({
    cssVariables: true,
    palette: {
      mode,
      primary: { main: mode === 'dark' ? '#7cc4ff' : '#00629b' },
      success: { main: mode === 'dark' ? '#6ddf8f' : '#1b7f3b' },
      warning: { main: mode === 'dark' ? '#ffbe5c' : '#a35a00' },
      error: { main: mode === 'dark' ? '#ff7b72' : '#b3261e' },
      background: {
        default: mode === 'dark' ? '#0f1419' : '#f4f6f8',
        paper: mode === 'dark' ? '#161b22' : '#ffffff',
      },
    },
    shape: { borderRadius: 8 },
    typography: {
      fontFamily: '"Inter", "Segoe UI", system-ui, sans-serif',
      fontSize: 14,
      button: { textTransform: 'none' },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: { body: { margin: 0, minHeight: '100vh' } },
      },
    },
  });
