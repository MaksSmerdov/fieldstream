import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import IconButton from '@mui/material/IconButton';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { Link as RouterLink, Outlet, useLocation } from 'react-router-dom';
import { SessionMenu } from '../features/auth/components/SessionMenu/SessionMenu.js';
import { useLivePatch } from '../shared/sse/useLivePatch.js';
import { LiveBanner } from '../shared/ui/LiveBanner/LiveBanner.js';
import { useThemeMode } from './theme-mode.js';
import styles from './AppLayout.module.scss';

/** Раздел, в котором сейчас находится пользователь: по нему подсвечивается вкладка. */
const sectionOf = (pathname: string): string => {
  if (pathname.startsWith('/alarms')) return '/alarms';
  if (pathname.startsWith('/device')) return '/device';

  return '/';
};

/**
 * Оболочка держит единственное соединение живого канала на вкладку. Подписка идёт без ключей,
 * то есть на весь стенд: на двадцати четырёх приборах дробить её по экранам нечего.
 */
export const AppLayout = (): React.JSX.Element => {
  const { pathname } = useLocation();
  const { mode, toggle } = useThemeMode();
  const section = sectionOf(pathname);
  useLivePatch([]);

  return (
    <Box className={styles['layout']}>
      <AppBar position="sticky" color="default" elevation={0} className={styles['layout__bar']}>
        <Toolbar className={styles['layout__toolbar']}>
          <Typography
            variant="h6"
            component={RouterLink}
            to="/"
            className={styles['layout__brand']}
          >
            Fieldstream
          </Typography>

          <Tabs value={section} className={styles['layout__tabs']}>
            <Tab label="Обзор" value="/" component={RouterLink} to="/" />
            <Tab label="Алармы" value="/alarms" component={RouterLink} to="/alarms" />
            {section === '/device' ? <Tab label="Прибор" value="/device" /> : null}
          </Tabs>

          <div className={styles['layout__session']}>
            <IconButton
              onClick={toggle}
              aria-label={mode === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
              className={styles['layout__theme']}
            >
              {mode === 'dark' ? '☀' : '☾'}
            </IconButton>

            <SessionMenu />
          </div>
        </Toolbar>
      </AppBar>

      <Container maxWidth="xl" component="main" className={styles['layout__content']}>
        <LiveBanner />
        <Outlet />
      </Container>
    </Box>
  );
};
