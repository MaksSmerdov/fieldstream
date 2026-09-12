import { createContext, use } from 'react';

export type ThemeMode = 'light' | 'dark';

export interface ThemeModeValue {
  readonly mode: ThemeMode;
  readonly toggle: () => void;
}

export const ThemeModeContext = createContext<ThemeModeValue>({
  mode: 'dark',
  toggle: () => undefined,
});

/** Текущая тема и переключатель. Выбор запоминается на вкладке, а не навязывается системой. */
export const useThemeMode = (): ThemeModeValue => use(ThemeModeContext);
