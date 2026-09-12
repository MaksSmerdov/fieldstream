import type { ReactNode } from 'react';
import { useSessionBootstrap } from '../features/auth/hooks/useSessionBootstrap.js';

/** Восстановление сессии до первого экрана: иначе перезагрузка страницы выбрасывает на вход. */
export const AppSession = ({ children }: { children: ReactNode }): React.JSX.Element => {
  useSessionBootstrap();

  return <>{children}</>;
};
