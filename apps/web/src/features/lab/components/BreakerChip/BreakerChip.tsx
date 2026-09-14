import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import type { BreakerState } from '@fieldstream/contracts';
import { countdownText, durationText } from '../../lab-format.js';
import { RING_RADIUS, probeCountdown, ringDash } from '../../lab-geometry.js';
import type { BreakerSnapshot, ProbeCountdown } from '../../lab-geometry.js';
import styles from './BreakerChip.module.scss';

interface Props {
  readonly breaker: BreakerSnapshot;
  readonly nowMs: number;
}

const STATE_WORD: Readonly<Record<BreakerState, string>> = {
  closed: 'замкнут',
  open: 'разомкнут',
  half_open: 'проба',
};

const STATE_COLOR: Readonly<Record<BreakerState, 'success' | 'error' | 'warning'>> = {
  closed: 'success',
  open: 'error',
  half_open: 'warning',
};

/** Что размыкатель делает сейчас, словами. */
const probeText = (breaker: BreakerSnapshot, countdown: ProbeCountdown | null): string => {
  if (breaker.state === 'closed') return 'запросы к прибору идут как обычно';
  if (breaker.state === 'half_open') return 'идёт пробный запрос';
  if (countdown === null) return 'время пробы неизвестно';
  if (countdown.waiting) return 'ждёт пробы';

  return `проба через ${countdownText(countdown.remainingMs)} из ${durationText(breaker.probeDelayMs)}`;
};

/** Размыкатель прибора: состояние, отказы подряд и кольцо отсчёта до пробы. */
export const BreakerChip = ({ breaker, nowMs }: Props): React.JSX.Element => {
  const countdown = probeCountdown(breaker, nowMs);
  const ring = ringDash(countdown?.fraction ?? 0);
  const text = probeText(breaker, countdown);

  return (
    <div className={styles['breaker']}>
      <svg
        className={styles['breaker__ring']}
        viewBox="0 0 40 40"
        width="40"
        height="40"
        role="img"
        aria-label={countdown === null ? 'Отсчёта до пробы нет' : `Отсчёт до пробы: ${text}`}
      >
        <circle className={styles['breaker__track']} cx="20" cy="20" r={RING_RADIUS} />
        {countdown === null ? null : (
          <circle
            className={styles['breaker__arc']}
            cx="20"
            cy="20"
            r={RING_RADIUS}
            strokeDasharray={ring.circumference}
            strokeDashoffset={ring.offset}
            transform="rotate(-90 20 20)"
          />
        )}
      </svg>

      <div className={styles['breaker__body']}>
        <div className={styles['breaker__head']}>
          <Typography variant="caption" color="text.secondary">
            Размыкатель
          </Typography>
          <span role="status" aria-live="polite">
            <Chip
              size="small"
              color={STATE_COLOR[breaker.state]}
              label={STATE_WORD[breaker.state]}
              className={styles['breaker__chip']}
            />
          </span>
          <Typography variant="body2" className={styles['breaker__failures']}>
            {`отказов подряд: ${breaker.failures}`}
          </Typography>
        </div>

        <Typography variant="body2" color="text.secondary" className={styles['breaker__probe']}>
          {text}
        </Typography>
      </div>
    </div>
  );
};
