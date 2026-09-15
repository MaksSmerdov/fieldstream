import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import type { DlqRedrive, DlqRedriveStatus } from '@fieldstream/contracts';
import { ApiError } from '../../../../shared/api/http.js';
import { counted } from '../../../../shared/text/plural.js';
import { REDRIVE_WAIT_LIMIT_MS, useDlqRedrive } from '../../hooks/dlq/useDlqRedrive.js';
import type { RedriveWatchStop } from '../../hooks/dlq/useDlqRedrive.js';
import styles from './RedriveControl.module.scss';

interface Props {
  readonly canRedrive: boolean;
  readonly unresolved: number;
}

const MAX_OPTIONS = [10, 50, 200] as const;

type MaxOption = (typeof MAX_OPTIONS)[number];

const GENITIVE_FORMS: readonly [string, string, string] = ['сообщения', 'сообщений', 'сообщений'];

const SEVERITY: Readonly<Record<DlqRedriveStatus, 'info' | 'success' | 'error'>> = {
  queued: 'info',
  running: 'info',
  done: 'success',
  failed: 'error',
};

const AFTER_STOP = 'Итог видно по счётам очереди, можно отправить новый запрос.';

/** Причина отказа из ответа шлюза; разбор ответа не по контракту наружу не выводится. */
const reasonOf = (error: unknown): string => {
  if (!(error instanceof ApiError)) return 'ответ шлюза не по контракту';

  return error.message.length > 0 ? error.message : 'причина неизвестна';
};

/** Ход запроса повторной подачи словами. */
const progressText = (
  redrive: DlqRedrive,
  stop: RedriveWatchStop | null,
  progressError: unknown,
): string => {
  if (stop === 'unreadable') {
    return `Ход запроса №${redrive.id} больше не узнать: ${reasonOf(progressError)}. ${AFTER_STOP}`;
  }
  if (stop === 'timeout') {
    const seconds = String(Math.round(REDRIVE_WAIT_LIMIT_MS / 1_000));
    return `Процессор не закончил запрос №${redrive.id} за ${seconds} с: возможно, он остановился посреди работы. ${AFTER_STOP}`;
  }
  if (redrive.status === 'queued') return `Запрос №${redrive.id} ждёт процессор`;
  if (redrive.status === 'running') {
    return `Процессор возвращает в обработку до ${counted(redrive.maxMessages, GENITIVE_FORMS)}`;
  }
  if (redrive.status === 'done') {
    return redrive.redriven === 0 && redrive.rejected === 0
      ? 'Готово: неразобранных сообщений не нашлось'
      : `Готово: возвращено ${redrive.redriven}, окончательно отвергнуто ${redrive.rejected}`;
  }

  return `Запрос не выполнен: ${redrive.error ?? 'причина неизвестна'}`;
};

/**
 * Кнопка повторной подачи с выбором количества и ходом запроса. Пока запрос идёт, кнопка
 * остаётся в порядке обхода и только сообщает о недоступности: фокус с неё не слетает.
 */
export const RedriveControl = ({ canRedrive, unresolved }: Props): React.JSX.Element => {
  const [max, setMax] = useState<MaxOption>(50);
  const control = useDlqRedrive();
  const { redrive, stop } = control;
  const pending =
    redrive !== null &&
    stop === null &&
    (redrive.status === 'queued' || redrive.status === 'running');
  const unavailable = canRedrive && (control.busy || unresolved === 0);

  return (
    <div className={styles['redrive']}>
      <div className={styles['redrive__controls']}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={max}
          disabled={!canRedrive}
          onChange={(_event, next: MaxOption | null) => {
            if (next !== null) setMax(next);
          }}
          aria-label="Сколько сообщений вернуть"
        >
          {MAX_OPTIONS.map((option) => (
            <ToggleButton key={option} value={option} className={styles['redrive__option']}>
              {option}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        <Button
          size="small"
          variant="contained"
          disabled={!canRedrive}
          aria-disabled={unavailable ? true : undefined}
          className={
            unavailable
              ? `${styles['redrive__action']} ${styles['redrive__action_waiting']}`
              : styles['redrive__action']
          }
          onClick={() => {
            if (!unavailable) control.start(max);
          }}
        >
          Вернуть в обработку
        </Button>
      </div>

      {canRedrive ? null : (
        <Alert severity="info" role="note" className={styles['redrive__notice']}>
          Возвращать сообщения в обработку может инженер. Здесь видно, что лежит в очереди.
        </Alert>
      )}

      {canRedrive && unresolved === 0 && !control.busy && redrive === null ? (
        <Typography variant="caption" color="text.secondary">
          Возвращать нечего: неразобранных сообщений нет.
        </Typography>
      ) : null}

      {control.sendError === null ? null : (
        <Alert severity="error" role="alert" className={styles['redrive__notice']}>
          {`Не удалось запросить повторную подачу: ${reasonOf(control.sendError)}`}
        </Alert>
      )}

      {control.sending ? (
        <Typography variant="body2" role="status" className={styles['redrive__sending']}>
          Отправляем запрос
        </Typography>
      ) : null}

      {redrive === null ? null : (
        <Alert
          severity={stop === null ? SEVERITY[redrive.status] : 'warning'}
          role={redrive.status === 'failed' || stop !== null ? 'alert' : 'status'}
          className={styles['redrive__notice']}
          {...(pending ? { icon: <CircularProgress size={18} color="inherit" /> } : {})}
        >
          {progressText(redrive, stop, control.progressError)}
        </Alert>
      )}

      {pending && control.progressError !== null ? (
        <Typography variant="caption" color="text.secondary">
          {`Не удалось узнать ход запроса: ${reasonOf(control.progressError)}. Спросим снова через секунду.`}
        </Typography>
      ) : null}
    </div>
  );
};
