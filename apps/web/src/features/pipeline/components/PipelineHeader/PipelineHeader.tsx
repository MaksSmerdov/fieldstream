import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { momentText, spanText } from '../../../../shared/time/human-time.js';
import { ageMs } from '../../../../shared/time/serverClock.js';
import { isSnapshotStale } from '../../pipeline-geometry.js';
import styles from './PipelineHeader.module.scss';

interface Props {
  readonly hasData: boolean;
  readonly sampledAt: string | null;
  readonly brokerError: string | null;
}

const TICK_MS = 1_000;

/** Заголовок конвейера: возраст снимка брокера и предупреждение, если брокер не отвечает. */
export const PipelineHeader = ({ hasData, sampledAt, brokerError }: Props): React.JSX.Element => {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setTick((tick) => tick + 1);
    }, TICK_MS);

    return () => {
      clearInterval(timer);
    };
  }, []);

  const age = ageMs(sampledAt);
  const stale = brokerError !== null || isSnapshotStale(age);

  return (
    <header className={styles['header']}>
      <div className={styles['header__title']}>
        <Typography variant="h5" component="h1">
          Конвейер
        </Typography>

        {hasData ? (
          <Chip
            size="small"
            variant="outlined"
            color={stale ? 'warning' : 'default'}
            className={styles['header__age']}
            label={
              age === null ? 'снимков брокера ещё не было' : `снимок брокера ${spanText(age)} назад`
            }
          />
        ) : null}
      </div>

      {hasData && brokerError !== null ? (
        <Alert severity="warning" role="alert" className={styles['header__broker']}>
          <AlertTitle>Брокер не отвечает</AlertTitle>
          <span className={styles['header__reason']}>{brokerError}</span>
          <span>
            {sampledAt === null
              ? 'Снимков брокера ещё не было.'
              : `Показан снимок от ${momentText(sampledAt)}.`}
          </span>
        </Alert>
      ) : null}
    </header>
  );
};
