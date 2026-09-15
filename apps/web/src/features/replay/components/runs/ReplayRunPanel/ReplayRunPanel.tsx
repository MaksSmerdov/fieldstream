import { useId } from 'react';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';
import type { ReplayRun } from '@fieldstream/contracts';
import { ApiError } from '../../../../../shared/api/http.js';
import { spanText } from '../../../../../shared/time/human-time.js';
import { useMetricParams } from '../../../hooks/useMetricParams.js';
import {
  QUEUE_HINT_MS,
  REPLAY_STATUS_COLOR,
  REPLAY_STATUS_PHRASE,
  REPLAY_STATUS_TEXT,
  elapsedText,
  isEmptyWindow,
  isReplayFinished,
  numberText,
  patchText,
  progressPercent,
  runElapsedMs,
  windowText,
} from '../../../replay-words.js';
import styles from './ReplayRunPanel.module.scss';

interface Props {
  readonly run: ReplayRun;
  readonly nowMs: number;
  readonly retentionMs: number;
  readonly pollError: unknown;
  readonly stopped: boolean;
}

/** Причина отказа опроса; разбор ответа не по контракту наружу не выводится. */
const reasonOf = (error: unknown): string => {
  if (!(error instanceof ApiError)) return 'ответ шлюза не по контракту';

  return error.message.length > 0 ? error.message : 'причина неизвестна';
};

/** Время прогона словами: сколько ждёт, сколько идёт или сколько длился. */
const timeText = (run: ReplayRun, nowMs: number): string => {
  const elapsed = elapsedText(runElapsedMs(run, nowMs));
  if (run.status === 'queued') return `в очереди ${elapsed}`;

  return isReplayFinished(run) ? `длился ${elapsed}` : `идёт ${elapsed}`;
};

/** Ход чтения словами. */
const progressText = (run: ReplayRun): string => {
  const { offsetsTotal, offsetsDone, framesMatched, framesRejected } = run.progress;
  if (run.status === 'queued') return 'Ждёт, пока процессор заберёт прогон';
  if (offsetsTotal === 0) {
    return run.status === 'running' ? 'Процессор ищет смещения окна в сыром топике' : '';
  }

  const rejected = framesRejected === 0 ? '' : `, отвергнуто ${numberText(framesRejected)}`;

  return (
    `Прочитано ${numberText(Math.min(offsetsDone, offsetsTotal))} из ${numberText(offsetsTotal)} смещений, ` +
    `${String(progressPercent(run.progress) ?? 0)}% · кадров выбранных приборов ${numberText(framesMatched)}${rejected}`
  );
};

/**
 * Ход перепрогона: статус, полоса по смещениям сырого топика, временная группа и итог. Полоса
 * не бывает больше ста процентов, даже если процессор дочитал хвост за границей окна.
 */
export const ReplayRunPanel = ({
  run,
  nowMs,
  retentionMs,
  pollError,
  stopped,
}: Props): React.JSX.Element => {
  const titleId = useId();
  const { labelOf } = useMetricParams(run.deviceCodes);
  const finished = isReplayFinished(run);
  const percent = progressPercent(run.progress);
  const emptyWindow = isEmptyWindow(run);
  const waitingMs = nowMs - Date.parse(run.createdAt);

  return (
    <Paper
      variant="outlined"
      component="section"
      aria-labelledby={titleId}
      className={styles['run']}
    >
      <div className={styles['run__head']}>
        <div className={styles['run__title']}>
          <Typography variant="subtitle1" component="h2" id={titleId}>
            Ход перепрогона
          </Typography>
          <Typography variant="caption" className={styles['run__meta']}>
            {`поставил ${run.requestedBy} · ${timeText(run, nowMs)}`}
          </Typography>
        </div>

        <Chip
          size="small"
          variant="outlined"
          color={REPLAY_STATUS_COLOR[run.status]}
          label={REPLAY_STATUS_TEXT[run.status]}
        />
      </div>

      <dl className={styles['run__facts']}>
        <dt>Окно</dt>
        <dd>{windowText(run.from, run.to)}</dd>
        <dt>Приборы</dt>
        <dd className={styles['run__codes']}>{run.deviceCodes.join(', ')}</dd>
        <dt>Правки</dt>
        <dd>
          <ul className={styles['run__patches']}>
            {run.patches.map((patch) => (
              <li key={`${patch.metricKey}|${patch.mode}`}>{patchText(patch, labelOf)}</li>
            ))}
          </ul>
        </dd>
      </dl>

      {run.status === 'failed' || emptyWindow ? null : (
        <div className={styles['run__progress']}>
          <LinearProgress
            aria-label="Прочитано смещений окна"
            {...(percent === null
              ? { variant: 'indeterminate' }
              : { variant: 'determinate', value: percent })}
          />
          <Typography variant="body2" className={styles['run__numbers']}>
            {progressText(run)}
          </Typography>
        </div>
      )}

      {run.groupId === null ? null : (
        <Typography variant="body2" className={styles['run__group']}>
          {finished ? 'Временная группа ' : 'Кадры читает временная группа '}
          <code className={styles['run__code']}>{run.groupId}</code>
          {finished ? (
            '. После итога процессор удаляет её из брокера.'
          ) : (
            <>
              {'. Пока прогон идёт, она видна на экране '}
              <Link component={RouterLink} to="/pipeline">
                Конвейер
              </Link>
              .
            </>
          )}
        </Typography>
      )}

      {run.status === 'queued' && waitingMs > QUEUE_HINT_MS ? (
        <Alert severity="info" role="status" className={styles['run__notice']}>
          {`Прогон ждёт процессор дольше ${spanText(QUEUE_HINT_MS)}. Обычно процессор забирает его за пару секунд; если ожидание затянулось, перепрогон на стенде выключен или процессор не запущен, и через минуту шлюз снимет прогон с ошибкой.`}
        </Alert>
      ) : null}

      {run.status === 'done' && emptyWindow ? (
        <Alert severity="info" role="status" className={styles['run__notice']}>
          {`В окне нет кадров: брокер не хранит сырых кадров за это время. Перепрогнать можно только кадры, которые стенд собрал сам за последние ${spanText(retentionMs)}.`}
        </Alert>
      ) : null}

      {run.status === 'done' && !emptyWindow ? (
        <Alert severity="success" role="status" className={styles['run__notice']}>
          {`Перепрогон готов за ${elapsedText(runElapsedMs(run, nowMs))}`}
        </Alert>
      ) : null}

      {run.status === 'failed' ? (
        <Alert severity="error" role="alert" className={styles['run__notice']}>
          {`Перепрогон не выполнен: ${run.error ?? 'причина неизвестна'}`}
        </Alert>
      ) : null}

      {stopped ? (
        <Alert severity="warning" role="alert" className={styles['run__notice']}>
          {`Ход прогона больше не узнать: ${reasonOf(pollError)}. Итог появится в списке последних прогонов.`}
        </Alert>
      ) : null}

      {!finished && !stopped && pollError !== null ? (
        <Typography variant="caption" color="text.secondary">
          {`Не удалось узнать ход прогона: ${reasonOf(pollError)}. Спросим снова через секунду.`}
        </Typography>
      ) : null}

      <p className={styles['run__hidden']} role="status" aria-live="polite">
        {REPLAY_STATUS_PHRASE[run.status]}
      </p>
    </Paper>
  );
};
