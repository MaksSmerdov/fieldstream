import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import type { HealthReason, HealthStatus } from '@fieldstream/contracts';
import styles from './StatusChip.module.scss';

interface Props {
  readonly status: HealthStatus;
  readonly reason: HealthReason;
  readonly since?: string | null;
  readonly lastOkAt?: string | null;
}

/** Машинная причина статуса словами: «не в порядке» без причины ничего не объясняет. */
const REASON_TEXT: Readonly<Record<HealthReason, string>> = {
  ok: 'опрос идёт',
  consecutive_errors: 'подряд идут отказы',
  stale: 'данные давно не обновлялись',
  no_data: 'данных ещё не было',
  awaiting_success: 'ждём первый удачный опрос',
  startup_grace: 'пауза после запуска',
  polling_disabled: 'опрос выключен',
  children_offline: 'дочерние узлы недоступны',
};

const COLOR: Readonly<Record<HealthStatus, 'success' | 'warning' | 'error' | 'default'>> = {
  online: 'success',
  degraded: 'warning',
  offline: 'error',
  unknown: 'default',
};

const LABEL: Readonly<Record<HealthStatus, string>> = {
  online: 'в сети',
  degraded: 'с ошибками',
  offline: 'нет связи',
  unknown: 'неизвестно',
};

export const StatusChip = ({ status, reason, since, lastOkAt }: Props): React.JSX.Element => {
  const lines = [
    `причина: ${REASON_TEXT[reason]}`,
    since == null ? null : `с ${since}`,
    lastOkAt == null ? null : `последний удачный опрос ${lastOkAt}`,
  ].filter((line): line is string => line !== null);

  return (
    <Tooltip title={lines.join('\n')} arrow>
      <Chip
        size="small"
        color={COLOR[status]}
        label={LABEL[status]}
        className={styles['status']}
        variant={status === 'unknown' ? 'outlined' : 'filled'}
      />
    </Tooltip>
  );
};
