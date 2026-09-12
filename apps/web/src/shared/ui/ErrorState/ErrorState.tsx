import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Button from '@mui/material/Button';
import { ApiError } from '../../api/http.js';
import styles from './ErrorState.module.scss';

interface Props {
  readonly error: unknown;
  readonly onRetry?: () => void;
}

/** Недоступный сервер и отозванная сессия это разные беды, и человеку надо сказать какая. */
const explain = (error: unknown): { title: string; hint: string } => {
  if (error instanceof ApiError && error.isUnavailable) {
    return { title: 'Сервер недоступен', hint: 'Данные не потеряны, попробуйте повторить запрос.' };
  }
  if (error instanceof ApiError && error.isUnauthorized) {
    return { title: 'Сессия закрыта', hint: 'Войдите заново, чтобы продолжить.' };
  }
  if (error instanceof ApiError && error.isForbidden) {
    return { title: 'Нет доступа', hint: 'Этот раздел закрыт для вашей роли.' };
  }

  return {
    title: 'Запрос не удался',
    hint: error instanceof Error ? error.message : 'Причина неизвестна.',
  };
};

export const ErrorState = ({ error, onRetry }: Props): React.JSX.Element => {
  const { title, hint } = explain(error);

  return (
    <Alert severity="error" className={styles['error']} role="alert">
      <AlertTitle>{title}</AlertTitle>
      {hint}
      {onRetry === undefined ? null : (
        <div className={styles['error__actions']}>
          <Button size="small" variant="outlined" color="inherit" onClick={onRetry}>
            Повторить
          </Button>
        </div>
      )}
    </Alert>
  );
};
