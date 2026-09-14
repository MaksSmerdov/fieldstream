import { useId } from 'react';
import Alert from '@mui/material/Alert';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { LineStatus } from '@fieldstream/contracts';
import { spanText } from '../../../../shared/time/human-time.js';
import { durationText } from '../../lab-format.js';
import { STALE_SNAPSHOT_MS, isSnapshotStale } from '../../lab-geometry.js';
import type { ChaosDevice } from '../../lab-lines.js';
import { BackoffLadder } from '../BackoffLadder/BackoffLadder.js';
import { BreakerChip } from '../BreakerChip/BreakerChip.js';
import { LatencyHistogram } from '../LatencyHistogram/LatencyHistogram.js';
import { WatchdogBar } from '../WatchdogBar/WatchdogBar.js';
import styles from './LineInstruments.module.scss';

interface Props {
  readonly snapshot: LineStatus;
  readonly device: ChaosDevice;
  readonly nowMs: number;
}

/** Приборы защиты сборщика по выбранному прибору и его линии. */
export const LineInstruments = ({ snapshot, device, nowMs }: Props): React.JSX.Element => {
  const titleId = useId();
  const breaker = snapshot.devices.find((item) => item.deviceCode === device.code)?.breaker;
  const ageMs = Math.max(0, nowMs - Date.parse(snapshot.ts));
  const stale = isSnapshotStale(snapshot.ts, nowMs);

  return (
    <section className={styles['instruments']} aria-labelledby={titleId}>
      <Paper variant="outlined" className={styles['instruments__head']}>
        <div className={styles['instruments__title']}>
          <Typography variant="subtitle1" component="h2" id={titleId}>
            {`Прибор ${device.code} на линии ${snapshot.lineCode}`}
          </Typography>
          {device.label === null ? null : (
            <Typography
              variant="body2"
              color="text.secondary"
              className={styles['instruments__label']}
            >
              {device.label}
            </Typography>
          )}
        </div>

        <Typography
          variant="caption"
          color="text.secondary"
          className={styles['instruments__facts']}
        >
          {`снимок ${spanText(ageMs)} назад · такт опроса ${durationText(snapshot.pollIntervalMs)} · таймаут запроса ${durationText(snapshot.requestTimeoutMs)}`}
        </Typography>

        {breaker === undefined ? (
          <Typography
            variant="body2"
            color="text.secondary"
            className={styles['instruments__missing']}
          >
            Сборщик не опрашивает этот прибор: в снимке линии его нет.
          </Typography>
        ) : (
          <BreakerChip breaker={breaker} nowMs={nowMs} />
        )}
      </Paper>

      {stale ? (
        <Alert severity="warning" role="status">
          {`Данные линии ${snapshot.lineCode} устарели: новых снимков нет дольше ${STALE_SNAPSHOT_MS / 1000} секунд. Показано последнее известное состояние.`}
        </Alert>
      ) : null}

      <div className={styles['instruments__grid']}>
        <BackoffLadder
          lineCode={snapshot.lineCode}
          connected={snapshot.connected}
          reconnects={snapshot.reconnects}
        />
        <WatchdogBar snapshot={snapshot} nowMs={nowMs} stale={stale} />
      </div>

      <LatencyHistogram
        lineCode={snapshot.lineCode}
        latency={snapshot.latency}
        requestTimeoutMs={snapshot.requestTimeoutMs}
      />
    </section>
  );
};
