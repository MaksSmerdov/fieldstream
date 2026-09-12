import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createAppTheme } from './theme.js';
import { ThemeModeContext } from './theme-mode.js';
import type { ThemeMode } from './theme-mode.js';

const STORAGE_KEY = 'fieldstream:theme';

/** Кэш серверного состояния. Живые данные патчат его точечно, без перезапроса всего окна. */
const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });

/** Выбор темы живёт в браузере. В приватном окне хранилище бросает, и это не повод падать. */
const readMode = (): ThemeMode => {
  try {
    const stored = globalThis.localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'dark';
  } catch {
    return 'dark';
  }
};

const writeMode = (mode: ThemeMode): void => {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    return;
  }
};

export const Providers = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [mode, setMode] = useState<ThemeMode>(readMode);
  const [client] = useState(createQueryClient);
  const theme = useMemo(() => createAppTheme(mode), [mode]);
  const modeValue = useMemo(
    () => ({
      mode,
      toggle: (): void => {
        setMode((current) => {
          const next = current === 'dark' ? 'light' : 'dark';
          writeMode(next);
          return next;
        });
      },
    }),
    [mode],
  );

  return (
    <QueryClientProvider client={client}>
      <ThemeModeContext value={modeValue}>
        <ThemeProvider theme={theme} defaultMode={mode}>
          <CssBaseline enableColorScheme />
          {children}
        </ThemeProvider>
      </ThemeModeContext>
    </QueryClientProvider>
  );
};
