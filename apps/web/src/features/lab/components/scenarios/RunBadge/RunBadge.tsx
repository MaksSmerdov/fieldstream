import Chip from '@mui/material/Chip';
import type { ScenarioRun } from '@fieldstream/contracts';
import { agoText, momentText } from '../../../../../shared/time/human-time.js';
import {
  RUN_STATUS_COLOR,
  RUN_STATUS_TEXT,
  SOURCE_TEXT,
  runMoment,
} from '../../../scenario-words.js';
import styles from './RunBadge.module.scss';

interface Props {
  readonly run: ScenarioRun | null;
}

/** Бейдж последнего прогона: итог словами и цветом, когда и откуда запущен. */
export const RunBadge = ({ run }: Props): React.JSX.Element => {
  if (run === null) {
    return (
      <div className={styles['badge']}>
        <span className={styles['badge__meta']}>ещё не запускался</span>
      </div>
    );
  }

  const moment = runMoment(run);

  return (
    <div className={styles['badge']}>
      <span className={styles['badge__hidden']}>Последний прогон:</span>
      <Chip
        size="small"
        variant="outlined"
        color={RUN_STATUS_COLOR[run.status]}
        label={RUN_STATUS_TEXT[run.status]}
        className={styles['badge__chip']}
      />
      <span className={styles['badge__meta']}>
        <time dateTime={moment} title={momentText(moment)}>
          {agoText(moment)}
        </time>
        {` · ${SOURCE_TEXT[run.source]}`}
      </span>
    </div>
  );
};
