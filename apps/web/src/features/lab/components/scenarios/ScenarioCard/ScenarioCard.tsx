import { useId, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { ScenarioRun, ScenarioSummary } from '@fieldstream/contracts';
import { ApiError } from '../../../../../shared/api/http.js';
import { limitText } from '../../../scenario-words.js';
import { RunBadge } from '../RunBadge/RunBadge.js';
import styles from './ScenarioCard.module.scss';

interface Props {
  readonly scenario: ScenarioSummary;
  readonly canRun: boolean;
  readonly busy: boolean;
  readonly activeRun: ScenarioRun | null;
  readonly progressShown: boolean;
  readonly launching: boolean;
  readonly failure: unknown;
  readonly onRun: () => void;
  readonly onDismissFailure: () => void;
}

/** Стенд занят другим прогоном: шлюз ответил 409. */
const isBusy = (error: unknown): boolean => error instanceof ApiError && error.status === 409;

/** Отказ запуска словами; разбор ответа не по контракту наружу не выводится. */
const failureText = (error: unknown): string => {
  if (!(error instanceof ApiError))
    return 'Не удалось запустить сценарий: ответ шлюза не по контракту';
  if (isBusy(error)) return `Стенд занят: ${error.message}`;

  return `Не удалось запустить сценарий: ${error.message.length > 0 ? error.message : 'причина неизвестна'}`;
};

/** Почему запуск сейчас недоступен; null, когда доступен. */
const waitText = (
  name: string,
  activeRun: ScenarioRun | null,
  progressShown: boolean,
  launching: boolean,
  busy: boolean,
): string | null => {
  if (launching) return 'Отправляем запуск';
  if (activeRun !== null && activeRun.scenario === name) {
    return progressShown
      ? 'Этот сценарий идёт сейчас, ход виден выше.'
      : 'Этот сценарий идёт сейчас: запуск станет доступен после его итога.';
  }
  if (activeRun !== null) {
    return `Сейчас идёт «${activeRun.title}»: запуск станет доступен после его итога.`;
  }

  return busy ? 'Запускается другой сценарий' : null;
};

/**
 * Карточка сценария: описание, предел длительности, шаги, последний прогон и запуск. Пока стенд
 * занят, кнопка остаётся в порядке обхода и только сообщает о недоступности.
 */
export const ScenarioCard = ({
  scenario,
  canRun,
  busy,
  activeRun,
  progressShown,
  launching,
  failure,
  onRun,
  onDismissFailure,
}: Props): React.JSX.Element => {
  const titleId = useId();
  const stepsId = useId();
  const hintId = useId();
  const [open, setOpen] = useState(false);
  const blocked = canRun && busy;
  const hint = canRun ? waitText(scenario.name, activeRun, progressShown, launching, busy) : null;

  return (
    <Paper
      variant="outlined"
      component="article"
      aria-labelledby={titleId}
      className={styles['scenario']}
    >
      <div className={styles['scenario__head']}>
        <div className={styles['scenario__title']}>
          <Typography variant="subtitle1" component="h3" id={titleId}>
            {scenario.title}
          </Typography>
          <Typography variant="caption" className={styles['scenario__facts']}>
            {`${scenario.name} · ${limitText(scenario.timeoutSec)}`}
          </Typography>
        </div>

        <RunBadge run={scenario.lastRun} />
      </div>

      <Typography variant="body2" className={styles['scenario__description']}>
        {scenario.description}
      </Typography>

      <div className={styles['scenario__steps']}>
        <Button
          size="small"
          variant="text"
          aria-expanded={open}
          aria-controls={stepsId}
          aria-describedby={titleId}
          className={styles['scenario__toggle']}
          onClick={() => {
            setOpen((current) => !current);
          }}
        >
          {`${open ? 'Скрыть шаги' : 'Показать шаги'} (${scenario.steps.length})`}
        </Button>

        <div id={stepsId} hidden={!open}>
          <ol className={styles['scenario__list']} aria-label={`Шаги сценария «${scenario.title}»`}>
            {scenario.steps.map((step, index) => (
              <li key={`${String(index)}-${step}`}>{step}</li>
            ))}
          </ol>
        </div>
      </div>

      {failure === null ? null : (
        <Alert
          severity={isBusy(failure) ? 'warning' : 'error'}
          role="alert"
          closeText="Закрыть"
          className={styles['scenario__notice']}
          onClose={onDismissFailure}
        >
          {failureText(failure)}
        </Alert>
      )}

      <div className={styles['scenario__actions']}>
        <Button
          size="small"
          variant="contained"
          disabled={!canRun}
          aria-disabled={blocked ? true : undefined}
          aria-describedby={hint === null ? titleId : `${titleId} ${hintId}`}
          className={
            blocked
              ? `${styles['scenario__launch']} ${styles['scenario__launch_waiting']}`
              : styles['scenario__launch']
          }
          onClick={() => {
            if (!blocked) onRun();
          }}
        >
          Запустить
        </Button>

        {hint === null ? null : (
          <Typography variant="caption" id={hintId} className={styles['scenario__hint']}>
            {hint}
          </Typography>
        )}
      </div>
    </Paper>
  );
};
