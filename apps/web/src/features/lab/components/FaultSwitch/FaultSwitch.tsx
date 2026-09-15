import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import type { SimFault } from '@fieldstream/contracts';
import { countdownText } from '../../lab-format.js';
import styles from './FaultSwitch.module.scss';

interface Props {
  readonly label: string;
  readonly active: SimFault | undefined;
  readonly nowMs: number;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onChange: (enabled: boolean) => void;
}

/** Остаток срока поломки словами. */
const leftText = (active: SimFault | undefined, pending: boolean, nowMs: number): string => {
  if (pending) return 'ждём';
  if (active === undefined) return '';

  return `ещё ${countdownText(Date.parse(active.expiresAt) - nowMs)}`;
};

/** Переключатель одной поломки с остатком её срока. */
export const FaultSwitch = ({
  label,
  active,
  nowMs,
  disabled,
  pending,
  onChange,
}: Props): React.JSX.Element => (
  <div className={styles['fault']}>
    <FormControlLabel
      className={styles['fault__control']}
      disabled={disabled || pending}
      control={
        <Switch
          size="small"
          checked={active !== undefined}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
      }
      label={label}
    />

    <span className={styles['fault__left']}>{leftText(active, pending, nowMs)}</span>
  </div>
);
