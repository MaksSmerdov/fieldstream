import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import { ApiError } from '../../api/http.js';
import styles from './ErrorBanner.module.scss';

interface Props {
  readonly error: unknown;
  readonly onRetry?: () => void;
}

/** Короткая причина: подробный разбор уместен, когда показывать больше нечего. */
const shortText = (error: unknown): string => {
  if (error instanceof ApiError && error.isUnavailable) return 'Сервер недоступен';
  if (error instanceof ApiError && error.isUnauthorized) return 'Сессия закрыта';
  if (error instanceof ApiError && error.isForbidden) return 'Нет доступа';

  return 'Обновить данные не удалось';
};

/**
 * Отказ поверх уже показанных данных. Прятать за ошибкой весь экран нельзя: числа в кэше
 * никуда не делись, они просто перестали обновляться, и об этом достаточно сказать строкой.
 * Убрать двадцать четыре прибора из-за одного неудачного перезапроса хуже, чем показать их
 * с пометкой о том, что они устаревают.
 */
export const ErrorBanner = ({ error, onRetry }: Props): React.JSX.Element => (
  <Alert severity="warning" role="status" className={styles['banner']}>
    {shortText(error)}: данные на экране могли устареть.
    {onRetry === undefined ? null : (
      <Button size="small" color="inherit" onClick={onRetry} className={styles['banner__action']}>
        Повторить
      </Button>
    )}
  </Alert>
);
