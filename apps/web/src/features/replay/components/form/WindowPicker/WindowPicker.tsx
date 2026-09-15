import { useId } from 'react';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { momentText, spanText } from '../../../../../shared/time/human-time.js';
import { WINDOW_LABEL, WINDOW_MS, WINDOW_PRESETS, localInputValue } from '../../../replay-form.js';
import type { WindowKey } from '../../../replay-form.js';
import styles from './WindowPicker.module.scss';

interface Props {
  readonly windowKey: WindowKey;
  readonly customFrom: string;
  readonly customTo: string;
  readonly retentionMs: number;
  readonly nowMs: number;
  readonly disabled: boolean;
  readonly onWindow: (key: WindowKey) => void;
  readonly onCustom: (edge: 'from' | 'to', value: string) => void;
}

const MINUTE_MS = 60_000;

/** Окно перепрогона: готовые длительности до текущего момента или своё в пределах срока хранения. */
export const WindowPicker = ({
  windowKey,
  customFrom,
  customTo,
  retentionMs,
  nowMs,
  disabled,
  onWindow,
  onCustom,
}: Props): React.JSX.Element => {
  const titleId = useId();
  const oldestMs = Math.ceil((nowMs - retentionMs) / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const bounds = { min: localInputValue(oldestMs), max: localInputValue(nowMs) };

  return (
    <div role="group" aria-labelledby={titleId} className={styles['window']}>
      <Typography variant="subtitle2" component="h3" id={titleId}>
        Окно
      </Typography>

      <ToggleButtonGroup
        size="small"
        exclusive
        value={windowKey}
        disabled={disabled}
        onChange={(_event, next: WindowKey | null) => {
          if (next !== null) onWindow(next);
        }}
        aria-label="Длительность окна"
        className={styles['window__options']}
      >
        {WINDOW_PRESETS.map((key) => (
          <ToggleButton
            key={key}
            value={key}
            disabled={disabled || WINDOW_MS[key] > retentionMs}
            className={styles['window__option']}
          >
            {WINDOW_LABEL[key]}
          </ToggleButton>
        ))}
        <ToggleButton value="custom" className={styles['window__option']}>
          {WINDOW_LABEL.custom}
        </ToggleButton>
      </ToggleButtonGroup>

      {windowKey === 'custom' ? (
        <div className={styles['window__custom']}>
          <TextField
            size="small"
            type="datetime-local"
            label="Начало"
            value={customFrom}
            disabled={disabled}
            onChange={(event) => {
              onCustom('from', event.target.value);
            }}
            helperText={`не раньше ${momentText(new Date(oldestMs).toISOString())}`}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: bounds }}
          />
          <TextField
            size="small"
            type="datetime-local"
            label="Конец"
            value={customTo}
            disabled={disabled}
            onChange={(event) => {
              onCustom('to', event.target.value);
            }}
            helperText="не позже текущего момента"
            slotProps={{ inputLabel: { shrink: true }, htmlInput: bounds }}
          />
        </div>
      ) : (
        <Typography variant="caption" className={styles['window__note']}>
          {`последние ${WINDOW_LABEL[windowKey]} до момента постановки`}
        </Typography>
      )}

      <Typography variant="caption" className={styles['window__note']}>
        {`Брокер хранит сырые кадры ${spanText(retentionMs)}. Засеянная история лежит только в базе, её перепрогнать нельзя: в перепрогон попадают кадры, которые стенд собрал сам.`}
      </Typography>
    </div>
  );
};
