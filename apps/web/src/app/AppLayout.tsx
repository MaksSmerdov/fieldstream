import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import IconButton from '@mui/material/IconButton';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { Link as RouterLink, Outlet, useLocation } from 'react-router-dom';
import { hasPermission } from '@fieldstream/contracts';
import type { ModuleId } from '@fieldstream/contracts';
import { SessionMenu } from '../features/auth/components/SessionMenu/SessionMenu.js';
import { useSessionStore } from '../shared/auth/session-store.js';
import { useLivePatch } from '../shared/sse/useLivePatch.js';
import { LiveBanner } from '../shared/ui/LiveBanner/LiveBanner.js';
import { ThemeIcon } from '../shared/ui/ThemeIcon/ThemeIcon.js';
import { useThemeMode } from './theme-mode.js';
import styles from './AppLayout.module.scss';

const NO_PERMISSIONS: readonly ModuleId[] = [];

/**
 * Раздел, в котором сейчас находится пользователь. У экрана прибора своей вкладки нет:
 * приборов двадцать четыре, и попадают на них из обзора, поэтому там не подсвечено ничего.
 */
const sectionOf = (pathname: string, permissions: readonly ModuleId[]): string | false => {
  if (pathname.startsWith('/alarms')) return '/alarms';
  if (pathname.startsWith('/pipeline'))
    return hasPermission(permissions, 'pipeline') && '/pipeline';
  if (pathname.startsWith('/lab')) return hasPermission(permissions, 'lab') && '/lab';
  if (pathname.startsWith('/replay')) return hasPermission(permissions, 'replay') && '/replay';
  if (pathname.startsWith('/device')) return false;

  return '/';
};

/**
 * Оболочка держит единственное соединение живого канала на вкладку. Подписка идёт без ключей,
 * то есть на весь стенд: на двадцати четырёх приборах дробить её по экранам нечего.
 */
export const AppLayout = (): React.JSX.Element => {
  const { pathname } = useLocation();
  const { mode, toggle } = useThemeMode();
  const permissions = useSessionStore((state) => state.user?.permissions) ?? NO_PERMISSIONS;
  const section = sectionOf(pathname, permissions);
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

          <Tabs
            value={section}
            variant="scrollable"
            scrollButtons="auto"
            allowScrollButtonsMobile
            className={styles['layout__tabs']}
          >
            <Tab label="Обзор" value="/" component={RouterLink} to="/" />
            <Tab label="Алармы" value="/alarms" component={RouterLink} to="/alarms" />
            {hasPermission(permissions, 'pipeline') ? (
              <Tab label="Конвейер" value="/pipeline" component={RouterLink} to="/pipeline" />
            ) : null}
            {hasPermission(permissions, 'lab') ? (
              <Tab label="Отказы" value="/lab" component={RouterLink} to="/lab" />
            ) : null}
            {hasPermission(permissions, 'replay') ? (
              <Tab label="Перепрогон" value="/replay" component={RouterLink} to="/replay" />
            ) : null}
          </Tabs>

          <div className={styles['layout__session']}>
            <IconButton
              onClick={toggle}
              aria-label={mode === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
              className={styles['layout__theme']}
            >
              <ThemeIcon mode={mode} />
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
