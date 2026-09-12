import { useEffect } from 'react';
import { api } from '../../../shared/api/endpoints.js';
import { useSessionStore } from '../../../shared/auth/session-store.js';

/**
 * Восстановление сессии при загрузке вкладки. Токен доступа живёт в памяти и после перезагрузки
 * его нет, но cookie обновления осталась: одна попытка прокрутить пару решает, показывать
 * приложение или форму входа. Неудача это не ошибка, а просто «вход нужен».
 */
export const useSessionBootstrap = (): void => {
  const checked = useSessionStore((state) => state.checked);

  useEffect(() => {
    if (checked) return;
    let cancelled = false;

    const restore = async (): Promise<void> => {
      try {
        const session = await api.refresh();
        if (!cancelled) useSessionStore.getState().setSession(session);
      } catch {
        if (!cancelled) useSessionStore.getState().markChecked();
      }
    };

    void restore();

    return () => {
      cancelled = true;
    };
  }, [checked]);
};
