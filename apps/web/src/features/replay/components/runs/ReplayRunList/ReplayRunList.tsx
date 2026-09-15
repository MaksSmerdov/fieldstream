import { useId } from 'react';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { ReplayRun } from '@fieldstream/contracts';
import { counted } from '../../../../../shared/text/plural.js';
import { agoText } from '../../../../../shared/time/human-time.js';
import { EmptyState } from '../../../../../shared/ui/EmptyState/EmptyState.js';
import {
  DEVICE_FORMS,
  PATCH_FORMS,
  REPLAY_STATUS_COLOR,
  REPLAY_STATUS_TEXT,
  windowText,
} from '../../../replay-words.js';
import styles from './ReplayRunList.module.scss';

interface Props {
  readonly runs: readonly ReplayRun[];
  readonly selectedId: string | null;
  readonly onSelect: (runId: string) => void;
}

/** Последние перепрогоны: статус, окно, объём и кто поставил; выбранный показан ниже. */
export const ReplayRunList = ({ runs, selectedId, onSelect }: Props): React.JSX.Element => {
  const titleId = useId();

  return (
    <Paper
      variant="outlined"
      component="section"
      aria-labelledby={titleId}
      className={styles['runs']}
    >
      <Typography variant="subtitle1" component="h2" id={titleId}>
        Последние перепрогоны
      </Typography>

      {runs.length === 0 ? (
        <EmptyState
          title="Перепрогонов ещё не было"
          hint="Поставьте первый: например, с готовой правкой границы испарителя в оттайке."
        />
      ) : (
        <ul className={styles['runs__list']} aria-label="Список перепрогонов">
          {runs.map((run) => {
            const selected = run.id === selectedId;

            return (
              <li key={run.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  className={
                    selected
                      ? `${styles['runs__item']} ${styles['runs__item_selected']}`
                      : styles['runs__item']
                  }
                  onClick={() => {
                    onSelect(run.id);
                  }}
                >
                  <span className={styles['runs__top']}>
                    <span className={styles['runs__window']}>{windowText(run.from, run.to)}</span>
                    <Chip
                      component="span"
                      size="small"
                      variant="outlined"
                      color={REPLAY_STATUS_COLOR[run.status]}
                      label={REPLAY_STATUS_TEXT[run.status]}
                      className={styles['runs__chip']}
                    />
                  </span>
                  <span className={styles['runs__meta']}>
                    {`${counted(run.deviceCodes.length, DEVICE_FORMS)} · ${counted(run.patches.length, PATCH_FORMS)}`}
                  </span>
                  <span className={styles['runs__meta']}>
                    {`${run.requestedBy} · ${agoText(run.createdAt)}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Paper>
  );
};
