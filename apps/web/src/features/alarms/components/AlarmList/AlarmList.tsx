import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Tooltip from '@mui/material/Tooltip';
import { Link as RouterLink } from 'react-router-dom';
import type { AlarmListItem, Severity } from '@fieldstream/contracts';
import { MODE_LABEL } from '../../../device/mode-view.js';
import { momentText, spanText } from '../../../../shared/time/human-time.js';
import { ageMs } from '../../../../shared/time/serverClock.js';
import styles from './AlarmList.module.scss';

interface Props {
  readonly items: readonly AlarmListItem[];
  readonly canAck: boolean;
  readonly pendingId: string | null;
  readonly onAck: (id: string) => void;
}

const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  info: 'сообщение',
  warning: 'предупреждение',
  critical: 'критическая',
};

const SEVERITY_COLOR: Readonly<Record<Severity, 'info' | 'warning' | 'error'>> = {
  info: 'info',
  warning: 'warning',
  critical: 'error',
};

/** Сколько эпизод длится: у незакрытого счёт идёт от подъёма до сейчас. */
const duration = (item: AlarmListItem): string => {
  const startedMs = Date.parse(item.occurredAt);
  const endedMs =
    item.clearedAt === null
      ? (ageMs(item.occurredAt) ?? 0) + startedMs
      : Date.parse(item.clearedAt);

  return spanText(endedMs - startedMs);
};

const boundaryText = (item: AlarmListItem): string => {
  const sign = item.boundary === 'max' ? 'выше' : 'ниже';
  const threshold = item.threshold === null ? '—' : String(item.threshold);
  const value = item.value === null ? '—' : String(item.value);

  return `${value} ${sign} уставки ${threshold}`;
};

/**
 * Лента эпизодов. Строка объясняет не только «что сработало», но и насколько: без значения
 * и уставки рядом эпизод не отличить от соседнего, а именно этим они и различаются.
 */
export const AlarmList = ({ items, canAck, pendingId, onAck }: Props): React.JSX.Element => (
  <Paper variant="outlined" className={styles['feed']}>
    <div className={styles['feed__head']}>
      <span>Момент</span>
      <span>Прибор</span>
      <span>Параметр</span>
      <span>Значение</span>
      <span>Длительность</span>
      <span>Состояние</span>
      <span>Подтверждение</span>
    </div>

    {items.map((item) => (
      <div key={item.id} className={styles['feed__row']} data-alarm={item.id}>
        <span className={styles['feed__moment']}>{momentText(item.occurredAt)}</span>

        <RouterLink to={`/device/${item.deviceCode}`} className={styles['feed__device']}>
          {item.deviceCode}
        </RouterLink>

        <span className={styles['feed__metric']}>
          {item.metricKey}
          <span className={styles['feed__mode']}> · {MODE_LABEL[item.mode]}</span>
        </span>

        <span className={styles['feed__value']}>{boundaryText(item)}</span>

        <span className={styles['feed__duration']}>{duration(item)}</span>

        <span className={styles['feed__state']}>
          <Chip
            size="small"
            color={SEVERITY_COLOR[item.severity]}
            variant={item.active ? 'filled' : 'outlined'}
            label={item.active ? SEVERITY_LABEL[item.severity] : 'снят'}
          />
        </span>

        <span className={styles['feed__ack']}>
          {item.ackedBy === null ? (
            canAck ? (
              <Button
                size="small"
                variant="outlined"
                disabled={pendingId === item.id}
                onClick={() => {
                  onAck(item.id);
                }}
              >
                Подтвердить
              </Button>
            ) : (
              <span className={styles['feed__quiet']}>не подтверждён</span>
            )
          ) : (
            <Tooltip
              title={`подтвердил ${item.ackedBy}, ${momentText(item.ackedAt)}`}
              arrow
              describeChild
            >
              {/* В колонку влезает имя, а не адрес целиком: полный адрес лежит в подсказке */}
              <span className={styles['feed__acked']}>{item.ackedBy.split('@')[0]}</span>
            </Tooltip>
          )}
        </span>
      </div>
    ))}
  </Paper>
);
