import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { PipelineResponse } from '@fieldstream/contracts';
import { numberText } from '../../pipeline-words.js';
import styles from './DlqCard.module.scss';

interface Props {
  readonly dlq: PipelineResponse['dlq'];
}

/** Очередь недоставленных: сколько кадров ждёт разбора и сколько попало туда всего. */
export const DlqCard = ({ dlq }: Props): React.JSX.Element => (
  <Paper
    variant="outlined"
    component="section"
    aria-label="Очередь недоставленных"
    className={styles['dlq']}
  >
    <Typography variant="subtitle1" component="h2">
      Очередь недоставленных
    </Typography>
    <Typography variant="caption" className={styles['dlq__hint']}>
      Сюда процессор откладывает кадры, которые не смог разобрать.
    </Typography>

    <dl className={styles['dlq__figures']}>
      <div className={styles['dlq__figure']}>
        <dt className={styles['dlq__label']}>неразобранных</dt>
        <dd
          className={
            dlq.unresolved > 0
              ? `${styles['dlq__value']} ${styles['dlq__value_warn']}`
              : styles['dlq__value']
          }
        >
          {numberText(dlq.unresolved)}
        </dd>
      </div>
      <div className={styles['dlq__figure']}>
        <dt className={styles['dlq__label']}>всего</dt>
        <dd className={styles['dlq__value']}>{numberText(dlq.total)}</dd>
      </div>
    </dl>
  </Paper>
);
