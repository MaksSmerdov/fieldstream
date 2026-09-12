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
      text:
        mode === 'dark'
          ? { primary: '#e6edf3', secondary: '#9fb0bf' }
          : { primary: '#17212b', secondary: '#48596a' },
      divider: mode === 'dark' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(23, 33, 43, 0.18)',
    },
    shape: { borderRadius: 8 },
    typography: {
      fontFamily: '"Inter", "Segoe UI", system-ui, sans-serif',
      fontSize: 14,
      button: { textTransform: 'none' },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: { margin: 0, minHeight: '100vh' },
          '*:focus:not(:focus-visible)': { outline: 'none' },
        },
      },
      MuiTooltip: {
        defaultProps: { arrow: true },
        styleOverrides: {
          tooltip: {
            maxWidth: 300,
            padding: '8px 10px',
            fontSize: 12,
            lineHeight: 1.55,
            textAlign: 'left',
            whiteSpace: 'pre-line',
          },
        },
      },
      MuiSelect: {
        defaultProps: {
          MenuProps: {
            anchorOrigin: { vertical: 'bottom', horizontal: 'left' },
            transformOrigin: { vertical: 'top', horizontal: 'left' },
            slotProps: { paper: { sx: { maxHeight: 320 } } },
          },
        },
      },
    },
  });
