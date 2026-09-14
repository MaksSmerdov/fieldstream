import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { ReconnectStep } from '@fieldstream/contracts';
import { durationText, signedDurationText } from '../../lab-format.js';
import { LADDER, LADDER_BOX, ladderSteps, reconnectDots } from '../../lab-geometry.js';
import styles from './BackoffLadder.module.scss';

interface Props {
  readonly lineCode: string;
  readonly connected: boolean;
  readonly reconnects: readonly ReconnectStep[];
}

const STEPS = ladderSteps();

/** Подпись графика для вспомогательных программ. */
const chartLabel = (lineCode: string, reconnects: readonly ReconnectStep[]): string => {
  const steps = STEPS.map((step) => String(step.baseMs / 1000)).join(', ');
  const facts =
    reconnects.length === 0
      ? 'Переподключений не было.'
      : `Фактические задержки: ${reconnects.map((step) => durationText(step.chosenMs)).join(', ')}.`;

  return `Лестница переподключения линии ${lineCode}: ступени ${steps} секунд с разбросом ${LADDER.jitter * 100} процентов. ${facts}`;
};

/** Итог переподключений словами с учётом того, подключена ли линия сейчас. */
const summaryText = (connected: boolean, reconnects: readonly ReconnectStep[]): string => {
  const last = reconnects.at(-1);
  if (last !== undefined) {
    return `Попыток в снимке: ${reconnects.length}. Последняя пауза ${durationText(last.chosenMs)} на ступени ${durationText(last.baseMs)}, разброс ${signedDurationText(last.jitterMs)}.`;
  }

  return connected
    ? 'Порт линии не пропадал: переподключений не было.'
    : 'Порт сейчас недоступен, попыток переподключения ещё не было.';
};

/** Лестница переподключения порта линии: ступени, полосы разброса и фактические задержки. */
export const BackoffLadder = ({ lineCode, connected, reconnects }: Props): React.JSX.Element => {
  const dots = reconnectDots(reconnects);
  const baseline = LADDER_BOX.height - LADDER_BOX.bottom;

  return (
    <Paper variant="outlined" className={styles['ladder']}>
      <div className={styles['ladder__head']}>
        <Typography variant="subtitle2" component="h3">
          Переподключение порта
        </Typography>
        <Chip
          size="small"
          variant="outlined"
          color={connected ? 'success' : 'error'}
          label={connected ? 'линия подключена' : 'порт недоступен'}
        />
      </div>

      <div className={styles['ladder__scroll']}>
        <svg
          className={styles['ladder__chart']}
          viewBox={`0 0 ${LADDER_BOX.width} ${LADDER_BOX.height}`}
          role="img"
          aria-label={chartLabel(lineCode, reconnects)}
        >
          <line
            className={styles['ladder__axis']}
            x1={LADDER_BOX.left}
            x2={LADDER_BOX.width - LADDER_BOX.right}
            y1={baseline}
            y2={baseline}
          />

          {STEPS.map((step, index) => {
            const previous = STEPS[index - 1];

            return (
              <g key={step.attempt}>
                <rect
                  className={styles['ladder__band']}
                  x={step.x + 3}
                  y={step.bandY}
                  width={step.width - 6}
                  height={step.bandHeight}
                />
                {previous === undefined ? null : (
                  <line
                    className={styles['ladder__tread']}
                    x1={step.x}
                    x2={step.x}
                    y1={previous.treadY}
                    y2={step.treadY}
                  />
                )}
                <line
                  className={styles['ladder__tread']}
                  x1={step.x}
                  x2={step.x + step.width}
                  y1={step.treadY}
                  y2={step.treadY}
                />
                <text
                  className={styles['ladder__tick']}
                  x={LADDER_BOX.left - 6}
                  y={step.treadY + 3}
                  textAnchor="end"
                >
                  {`${step.baseMs / 1000} с`}
                </text>
                <text
                  className={styles['ladder__tick']}
                  x={step.x + step.width / 2}
                  y={LADDER_BOX.height - 12}
                  textAnchor="middle"
                >
                  {step.attempt === LADDER.steps - 1 ? `${step.attempt}+` : String(step.attempt)}
                </text>
              </g>
            );
          })}

          {dots.map((dot) => (
            <circle key={dot.key} className={styles['ladder__dot']} cx={dot.x} cy={dot.y} r="4">
              <title>{`попытка ${dot.attempt}: ${durationText(dot.chosenMs)}`}</title>
            </circle>
          ))}
        </svg>
      </div>

      <Typography variant="caption" color="text.secondary" className={styles['ladder__legend']}>
        По горизонтали номер попытки, по вертикали пауза перед ней. Полоса показывает разброс
        плюс-минус 10 процентов, точки это выбранные паузы.
      </Typography>

      <Typography variant="body2" className={styles['ladder__summary']}>
        {summaryText(connected, reconnects)}
      </Typography>
    </Paper>
  );
};
