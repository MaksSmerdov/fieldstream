import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import styles from './EmptyState.module.scss';

interface Props {
  readonly title: string;
  readonly hint?: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}

/** Пустота объясняется словами и даёт действие: «нет данных» само по себе ничего не говорит. */
export const EmptyState = ({ title, hint, actionLabel, onAction }: Props): React.JSX.Element => (
  <div className={styles['empty']}>
    <Typography variant="subtitle1">{title}</Typography>
    {hint === undefined ? null : (
      <Typography variant="body2" color="text.secondary">
        {hint}
      </Typography>
    )}
    {actionLabel === undefined || onAction === undefined ? null : (
      <Button variant="outlined" size="small" onClick={onAction}>
        {actionLabel}
      </Button>
    )}
  </div>
);
