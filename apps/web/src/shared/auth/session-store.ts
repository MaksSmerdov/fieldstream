import { create } from 'zustand';
import type { SessionUser } from '@fieldstream/contracts';

/**
 * Сессия вкладки. Токен доступа живёт только в памяти: из localStorage его достанет любой
 * сторонний скрипт, а после перезагрузки сессия восстанавливается по cookie обновления.
 */
export interface SessionState {
  readonly accessToken: string | null;
  readonly expiresAt: string | null;
  readonly user: SessionUser | null;
  /** Пока не проверили cookie обновления, вкладка не знает, вошёл ли человек. */
  readonly checked: boolean;
  readonly setSession: (session: {
    accessToken: string;
    expiresAt: string;
    user: SessionUser;
  }) => void;
  readonly markChecked: () => void;
  readonly clear: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  accessToken: null,
  expiresAt: null,
  user: null,
  checked: false,
  setSession: (session) => {
    set({
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
      user: session.user,
      checked: true,
    });
  },
  markChecked: () => {
    set({ checked: true });
  },
  clear: () => {
    set({ accessToken: null, expiresAt: null, user: null, checked: true });
  },
}));

/** Доступ к токену вне React: слой запросов не должен зависеть от дерева компонентов. */
export const currentAccessToken = (): string | null => useSessionStore.getState().accessToken;

export const currentUser = (): SessionUser | null => useSessionStore.getState().user;

export const hasPermissionNow = (module: string): boolean =>
  useSessionStore.getState().user?.permissions.some((item) => item === module) ?? false;
