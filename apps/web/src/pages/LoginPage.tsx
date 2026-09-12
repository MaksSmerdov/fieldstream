import Box from '@mui/material/Box';
import { Navigate, useLocation } from 'react-router-dom';
import { LoginForm } from '../features/auth/components/LoginForm/LoginForm.js';
import { BootPanel } from '../features/boot/components/BootPanel/BootPanel.js';
import { useSessionStore } from '../shared/auth/session-store.js';
import styles from './LoginPage.module.scss';

interface FromState {
  readonly from?: string;
}

/** Вход и рядом состояние стенда: если данные ещё готовятся, это видно до первого экрана. */
export const LoginPage = (): React.JSX.Element => {
  const user = useSessionStore((state) => state.user);
  const location = useLocation();

  if (user !== null) {
    const state = location.state as FromState | null;

    return <Navigate to={state?.from ?? '/'} replace />;
  }

  return (
    <Box className={styles['login-page']}>
      <LoginForm />
      <BootPanel />
    </Box>
  );
};
