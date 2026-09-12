import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';
import type { DeviceSnapshot } from '@fieldstream/contracts';
import { StatusChip } from '../../../../shared/ui/StatusChip/StatusChip.js';
import { agoText } from '../../../../shared/time/human-time.js';
import { MODE_LABEL } from '../../mode-view.js';
import styles from './DeviceHeader.module.scss';

interface Props {
  readonly snapshot: DeviceSnapshot;
}

export const DeviceHeader = ({ snapshot }: Props): React.JSX.Element => (
  <header className={styles['header']}>
    <div className={styles['header__title']}>
      <Typography variant="h5">Прибор {snapshot.deviceCode}</Typography>
      <Typography variant="body2" color="text.secondary">
        {snapshot.label}
      </Typography>
    </div>

    <div className={styles['header__facts']}>
      <StatusChip
        status={snapshot.status}
        reason={snapshot.reason}
        since={snapshot.since}
        lastOkAt={snapshot.lastOkAt}
      />
      <Chip size="small" variant="outlined" label={`режим: ${MODE_LABEL[snapshot.mode]}`} />
      <Chip
        size="small"
        variant="outlined"
        color={snapshot.stale ? 'warning' : 'default'}
        label={`данные ${agoText(snapshot.ts)}`}
      />
      {snapshot.consecutiveErrors === 0 ? null : (
        <Chip
          size="small"
          color="warning"
          label={`отказов подряд: ${String(snapshot.consecutiveErrors)}`}
        />
      )}
      {snapshot.activeAlarms === 0 ? null : (
        <Chip
          size="small"
          color="error"
          component={RouterLink}
          clickable
          to={`/alarms?device=${snapshot.deviceCode}`}
          label={`активных алармов: ${String(snapshot.activeAlarms)}`}
        />
      )}
    </div>

    <Typography variant="caption" color="text.secondary" className={styles['header__path']}>
      {snapshot.siteCode} · линия {snapshot.lineCode} · модель {snapshot.profileKey} версии{' '}
      {snapshot.profileVersion}
    </Typography>
  </header>
);
