import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { TopologySummary } from '../../topology-patch.js';
import styles from './SummaryBar.module.scss';

interface Props {
  readonly summary: TopologySummary;
}

/** Сводка стенда одной строкой: сколько приборов, сколько в сети, сколько просит внимания. */
export const SummaryBar = ({ summary }: Props): React.JSX.Element => (
  <Paper className={styles['summary']} elevation={0} role="group" aria-label="Сводка по стенду">
    {[
      { label: 'приборов', value: summary.devices, tone: 'plain' as const },
      { label: 'в сети', value: summary.online, tone: 'good' as const },
      { label: 'нет связи', value: summary.offline, tone: 'bad' as const },
      { label: 'данные устарели', value: summary.stale, tone: 'warn' as const },
      { label: 'активных алармов', value: summary.activeAlarms, tone: 'warn' as const },
    ].map((item) => (
      <div key={item.label} className={styles['summary__item']}>
        <Typography variant="h5" className={styles[`summary__value_${item.tone}`]}>
          {item.value}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {item.label}
        </Typography>
      </div>
    ))}
  </Paper>
);
