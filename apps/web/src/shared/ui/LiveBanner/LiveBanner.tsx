import Alert from '@mui/material/Alert';
import { useLiveStore } from '../../sse/live-store.js';
import styles from './LiveBanner.module.scss';

/** Время последнего кадра человеку: «канал молчит» без времени не даёт понять, насколько всё плохо. */
const clock = (atMs: number | null): string =>
  atMs === null ? 'данных ещё не было' : `данные от ${new Date(atMs).toLocaleTimeString('ru-RU')}`;

/**
 * Баннер живого канала. Показанные числа при обрыве остаются верными, но их возраст надо
 * назвать: молча оставлять экран «живым» хуже, чем честно сказать, что обновлений нет.
 */
export const LiveBanner = (): React.JSX.Element | null => {
  const status = useLiveStore((state) => state.status);
  const lastFrameAtMs = useLiveStore((state) => state.lastFrameAtMs);

  if (status === 'live') return null;

  return (
    <Alert
      severity={status === 'offline' ? 'warning' : 'info'}
      className={styles['live-banner']}
      role="status"
    >
      {status === 'offline'
        ? `Живой канал недоступен, ${clock(lastFrameAtMs)}`
        : 'Подключаемся к живому каналу'}
    </Alert>
  );
};
