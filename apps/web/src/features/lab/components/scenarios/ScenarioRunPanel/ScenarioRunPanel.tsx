import { useId } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { ScenarioRun, ScenarioRunStep } from '@fieldstream/contracts';
import { ApiError } from '../../../../../shared/api/http.js';
import {
  RUN_STATUS_COLOR,
  RUN_STATUS_TEXT,
  SOURCE_TEXT,
  STEP_STATUS_TEXT,
  elapsedText,
  isRunFinished,
  runElapsedMs,
} from '../../../scenario-words.js';
import styles from './ScenarioRunPanel.module.scss';

interface Props {
  readonly run: ScenarioRun;
  readonly nowMs: number;
  readonly pollError: unknown;
  readonly stopped: boolean;
  readonly onDismiss: () => void;
}

/** Причина отказа опроса; разбор ответа не по контракту наружу не выводится. */
const reasonOf = (error: unknown): string => {
  if (!(error instanceof ApiError)) return 'ответ шлюза не по контракту';

  return error.message.length > 0 ? error.message : 'причина неизвестна';
};

/** Время прогона словами: сколько ждёт, сколько идёт или сколько длился. */
const timeText = (run: ScenarioRun, nowMs: number): string => {
  const elapsed = elapsedText(runElapsedMs(run, nowMs));
  if (run.status === 'queued') return `в очереди ${elapsed}`;

  return isRunFinished(run) ? `длился ${elapsed}` : `прошло ${elapsed}`;
};

/** Причина провала: ошибка прогона или пояснение проваленного шага. */
const failureReason = (run: ScenarioRun): string =>
  run.error ?? run.steps.find((step) => step.status === 'failed')?.detail ?? 'причина неизвестна';

/** Текущий шаг для объявления вспомогательными программами. */
const currentText = (run: ScenarioRun): string => {
  const current = run.steps.find((step) => step.status === 'running');

  return current === undefined
    ? ''
    : `Шаг ${current.index + 1} из ${run.steps.length}: ${current.title}`;
};

/** Ход прогона: шаги со статусами и пояснениями, текущий шаг выделен, итог словами. */
export const ScenarioRunPanel = ({
  run,
  nowMs,
  pollError,
  stopped,
  onDismiss,
}: Props): React.JSX.Element => {
  const titleId = useId();
  const finished = isRunFinished(run);

  const renderStep = (step: ScenarioRunStep): React.JSX.Element => {
    const current = step.status === 'running';

    return (
      <li
        key={step.index}
        className={
          current ? `${styles['run__step']} ${styles['run__step_current']}` : styles['run__step']
        }
        aria-current={current ? 'step' : undefined}
      >
        <span className={`${styles['run__status']} ${styles[`run__status_${step.status}`]}`}>
          {STEP_STATUS_TEXT[step.status]}
        </span>
        <span className={styles['run__step-title']}>{step.title}</span>
        {step.detail === null ? null : <span className={styles['run__detail']}>{step.detail}</span>}
      </li>
    );
  };

  return (
    <Paper
      variant="outlined"
      component="section"
      aria-labelledby={titleId}
      className={styles['run']}
    >
      <div className={styles['run__head']}>
        <div className={styles['run__title']}>
          <Typography variant="subtitle1" component="h3" id={titleId}>
            {`Прогон «${run.title}»`}
          </Typography>
          <Typography variant="caption" className={styles['run__meta']}>
            {`запустил ${run.requestedBy} ${SOURCE_TEXT[run.source]} · ${timeText(run, nowMs)}`}
          </Typography>
        </div>

        <div className={styles['run__side']}>
          <Chip
            size="small"
            variant="outlined"
            color={RUN_STATUS_COLOR[run.status]}
            label={RUN_STATUS_TEXT[run.status]}
          />
          {finished || stopped ? (
            <Button size="small" onClick={onDismiss}>
              Скрыть итог
            </Button>
          ) : null}
        </div>
      </div>

      <ol className={styles['run__steps']} aria-label="Шаги прогона">
        {run.steps.map(renderStep)}
      </ol>

      <p className={styles['run__hidden']} role="status" aria-live="polite">
        {currentText(run)}
      </p>

      {run.status === 'passed' ? (
        <Alert severity="success" role="status" className={styles['run__notice']}>
          {`Сценарий прошёл за ${elapsedText(runElapsedMs(run, nowMs))}`}
        </Alert>
      ) : null}

      {run.status === 'failed' ? (
        <Alert severity="error" role="alert" className={styles['run__notice']}>
          {`Сценарий провален: ${failureReason(run)}`}
        </Alert>
      ) : null}

      {stopped ? (
        <Alert severity="warning" role="alert" className={styles['run__notice']}>
          {`Ход прогона больше не узнать: ${reasonOf(pollError)}. Итог появится в карточке сценария.`}
        </Alert>
      ) : null}

      {!finished && !stopped && pollError !== null ? (
        <Typography variant="caption" color="text.secondary">
          {`Не удалось узнать ход прогона: ${reasonOf(pollError)}. Спросим снова через секунду.`}
        </Typography>
      ) : null}
    </Paper>
  );
};
