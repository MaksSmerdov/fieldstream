import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { PipelineRebalance } from '@fieldstream/contracts';
import { momentText } from '../../../../shared/time/human-time.js';
import styles from './RebalanceLog.module.scss';

interface Props {
  readonly rebalances: readonly PipelineRebalance[];
}

/** Журнал смен состава групп, новые сверху; добавления объявляются вслух. */
export const RebalanceLog = ({ rebalances }: Props): React.JSX.Element => (
  <Paper
    variant="outlined"
    component="section"
    aria-label="Журнал ребалансов"
    className={styles['log']}
  >
    <Typography variant="subtitle1" component="h2">
      Журнал ребалансов
    </Typography>

    {rebalances.length === 0 ? (
      <Typography variant="body2" className={styles['log__empty']}>
        Ребалансов пока не было: состав групп не менялся с тех пор, как шлюз начал опрос.
      </Typography>
    ) : null}

    <div
      className={styles['log__scroll']}
      role="region"
      aria-label="Записи журнала ребалансов"
      tabIndex={rebalances.length === 0 ? -1 : 0}
    >
      <ol className={styles['log__list']} aria-live="polite" aria-relevant="additions">
        {rebalances.map((item) => (
          <li key={`${item.at}|${item.groupId}`} className={styles['log__item']}>
            <span className={styles['log__moment']}>{momentText(item.at)}</span>
            <span className={styles['log__group']}>{item.groupId}</span>
            <span className={styles['log__change']}>
              участников было {item.membersBefore}, стало {item.membersAfter}
            </span>
          </li>
        ))}
      </ol>
    </div>
  </Paper>
);
