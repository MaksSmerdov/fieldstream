import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSessionStore } from '../shared/auth/session-store.js';

/**
 * Защита маршрутов. Пока вкладка не проверила cookie обновления, решения нет: уход на форму
 * входа в этот момент выбрасывал бы человека при каждой перезагрузке.
 */
export const RequireAuth = (): React.JSX.Element => {
  // Селекторы по одному полю: объект из селектора сравнивается по ссылке и уводит хранилище
  // в бесконечный перерендер
  const user = useSessionStore((state) => state.user);
  const checked = useSessionStore((state) => state.checked);
  const location = useLocation();

  if (!checked) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
        <CircularProgress aria-label="Проверяем сессию" />
      </Box>
    );
  }

  if (user === null) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  return <Outlet />;
};
