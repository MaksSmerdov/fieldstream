import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { spanText } from '../../../../shared/time/human-time.js';
import { lagTrend, sparkline } from '../../pipeline-geometry.js';
import type { LagHistory, LagPoint } from '../../pipeline-geometry.js';
import { TREND_WORDS, numberText } from '../../pipeline-words.js';
import styles from './LagHistoryPanel.module.scss';

interface Props {
  readonly groupIds: readonly string[];
  readonly history: LagHistory;
}

const WIDTH = 240;
const HEIGHT = 48;

/** Подпись линии истории для вспомогательных программ. */
const labelOf = (groupId: string, points: readonly LagPoint[]): string => {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return `Отставание группы ${groupId}: истории нет`;

  const lags = points.map((point) => point.lag);

  return (
    `Отставание группы ${groupId} за ${spanText(last.atMs - first.atMs)}: ` +
    `от ${numberText(Math.min(...lags))} до ${numberText(Math.max(...lags))}, ` +
    `сейчас ${numberText(last.lag)}, ${TREND_WORDS[lagTrend(points)]}`
  );
};

/** История суммарного отставания групп за последние минуты открытого экрана. */
export const LagHistoryPanel = ({ groupIds, history }: Props): React.JSX.Element => (
  <Paper
    variant="outlined"
    component="section"
    aria-label="История отставания"
    className={styles['history']}
  >
    <Typography variant="subtitle1" component="h2">
      История отставания
    </Typography>
    <Typography variant="caption" className={styles['history__hint']}>
      Копится, пока экран открыт, не дольше последних 5 минут.
    </Typography>

    {groupIds.length === 0 ? (
      <Typography variant="body2" className={styles['history__hint']}>
        Групп нет, отставанию не у кого копиться.
      </Typography>
    ) : (
      <ul className={styles['history__list']}>
        {groupIds.map((groupId) => {
          const points = history.series.get(groupId) ?? [];
          const trend = lagTrend(points);
          const last = points[points.length - 1];
          const line = sparkline(points, WIDTH, HEIGHT);

          return (
            <li key={groupId} className={styles['history__row']}>
              <span className={styles['history__group']}>{groupId}</span>

              {points.length < 2 ? (
                <span className={styles['history__empty']}>нужно хотя бы два снимка</span>
              ) : (
                <svg
                  className={styles['history__chart']}
                  viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={labelOf(groupId, points)}
                >
                  <line
                    x1={0}
                    y1={HEIGHT - 4}
                    x2={WIDTH}
                    y2={HEIGHT - 4}
                    className={styles['history__axis']}
                    vectorEffect="non-scaling-stroke"
                  />
                  <path
                    d={line.path}
                    className={
                      trend === 'growing'
                        ? `${styles['history__line']} ${styles['history__line_growing']}`
                        : styles['history__line']
                    }
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              )}

              <span className={styles['history__value']}>
                {last === undefined ? '–' : numberText(last.lag)}
                <span
                  className={
                    trend === 'growing'
                      ? `${styles['history__trend']} ${styles['history__trend_growing']}`
                      : styles['history__trend']
                  }
                >
                  {TREND_WORDS[trend]}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    )}
  </Paper>
);
