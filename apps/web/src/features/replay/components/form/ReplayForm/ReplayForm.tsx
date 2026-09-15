import { useId, useReducer } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { ReplayRun } from '@fieldstream/contracts';
import { ApiError } from '../../../../../shared/api/http.js';
import { ErrorBanner } from '../../../../../shared/ui/ErrorBanner/ErrorBanner.js';
import { getServerNowMs } from '../../../../../shared/time/serverClock.js';
import { useDeviceRules } from '../../../hooks/useDeviceRules.js';
import { useMetricParams } from '../../../hooks/useMetricParams.js';
import { useReplayDevices } from '../../../hooks/useReplayDevices.js';
import type { ReplayLaunch } from '../../../hooks/runs/useReplayLaunch.js';
import {
  EXAMPLE_HINT,
  EXAMPLE_LABEL,
  INITIAL_FORM,
  MAX_PATCHES,
  evaluateForm,
  replayFormReducer,
  ruleOptions,
} from '../../../replay-form.js';
import type { FormContext } from '../../../replay-form.js';
import { DevicePicker } from '../DevicePicker/DevicePicker.js';
import { PatchEditor } from '../PatchEditor/PatchEditor.js';
import { WindowPicker } from '../WindowPicker/WindowPicker.js';
import styles from './ReplayForm.module.scss';

interface Props {
  readonly canRun: boolean;
  readonly retentionMs: number;
  readonly nowMs: number;
  /** Идущий прогон: пока он не завершился, новый шлюз не примет. */
  readonly busyRun: ReplayRun | null;
  readonly launch: ReplayLaunch;
}

/** Отказ постановки словами; разбор ответа не по контракту наружу не выводится. */
const failureText = (error: unknown): string => {
  if (!(error instanceof ApiError)) {
    return 'Не удалось поставить перепрогон: ответ шлюза не по контракту';
  }
  const reason = error.message.length > 0 ? error.message : 'причина неизвестна';
  if (error.status === 409) return `Стенд занят: ${reason}. Идущий прогон показан ниже.`;

  return `Не удалось поставить перепрогон: ${reason}`;
};

/** Почему поставить сейчас нельзя; null, когда можно. */
const waitText = (busyRun: ReplayRun | null, sending: boolean): string | null => {
  if (sending) return 'Отправляем запрос';
  if (busyRun !== null) {
    return `Сейчас идёт перепрогон, который поставил ${busyRun.requestedBy}: новый можно поставить после его итога.`;
  }

  return null;
};

/**
 * Форма перепрогона: приборы, окно и правки уставок. Проверяется до отправки теми же правилами,
 * что у шлюза, а текущие значения уставок подсказываются рядом с полями.
 */
export const ReplayForm = ({
  canRun,
  retentionMs,
  nowMs,
  busyRun,
  launch,
}: Props): React.JSX.Element => {
  const titleId = useId();
  const patchesId = useId();
  const hintId = useId();
  const exampleId = useId();
  const [state, dispatch] = useReducer(replayFormReducer, INITIAL_FORM);
  const devices = useReplayDevices();
  const rules = useDeviceRules(state.devices);
  const params = useMetricParams(state.devices);
  const options = ruleOptions(rules, state.devices);
  const locked = !canRun;

  const context: FormContext = { nowMs, retentionMs, rules, labelOf: params.labelOf };
  const outcome = evaluateForm(state, context);
  const blocked = canRun && (busyRun !== null || launch.sending);
  const hint = canRun ? waitText(busyRun, launch.sending) : null;

  const submit = (): void => {
    if (blocked) return;
    dispatch({ type: 'submit' });
    const fresh = evaluateForm(state, { ...context, nowMs: getServerNowMs() });
    if (fresh.request !== null) launch.launch(fresh.request);
  };

  return (
    <Paper
      variant="outlined"
      component="section"
      aria-labelledby={titleId}
      className={styles['form']}
    >
      <div className={styles['form__head']}>
        <Typography variant="subtitle1" component="h2" id={titleId}>
          Новый перепрогон
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Правка действует только внутри перепрогона: боевые уставки остаются как были.
        </Typography>
      </div>

      {canRun ? null : (
        <Alert severity="info" role="note" className={styles['form__notice']}>
          Ставить перепрогон может инженер. Здесь видно, как идут прогоны и чем они закончились.
        </Alert>
      )}

      <DevicePicker
        devices={devices}
        selected={state.devices}
        disabled={locked}
        onToggle={(code) => {
          dispatch({ type: 'toggleDevice', code });
        }}
        onSet={(codes) => {
          dispatch({ type: 'setDevices', codes });
        }}
      />

      <WindowPicker
        windowKey={state.windowKey}
        customFrom={state.customFrom}
        customTo={state.customTo}
        retentionMs={retentionMs}
        nowMs={nowMs}
        disabled={locked}
        onWindow={(key) => {
          dispatch({ type: 'setWindow', key, nowMs: getServerNowMs() });
        }}
        onCustom={(edge, value) => {
          dispatch({ type: 'setCustom', edge, value });
        }}
      />

      <div role="group" aria-labelledby={patchesId} className={styles['form__patches']}>
        <Typography variant="subtitle2" component="h3" id={patchesId}>
          Правки уставок
        </Typography>

        <div className={styles['form__example']}>
          <Button
            size="small"
            variant="outlined"
            disabled={locked || devices.chambers.length === 0}
            aria-describedby={exampleId}
            onClick={() => {
              dispatch({ type: 'applyExample', chambers: devices.chambers });
            }}
          >
            {EXAMPLE_LABEL}
          </Button>
          <Typography variant="caption" id={exampleId} className={styles['form__caption']}>
            {EXAMPLE_HINT}
          </Typography>
        </div>

        {rules.failed ? <ErrorBanner error={rules.error} onRetry={rules.refetch} /> : null}

        {state.patches.map((draft, index) => (
          <PatchEditor
            key={draft.id}
            draft={draft}
            index={index}
            codes={state.devices}
            options={options}
            rules={rules}
            labelOf={params.labelOf}
            disabled={locked}
            removable={state.patches.length > 1}
            onEdit={(edit) => {
              dispatch({ type: 'editPatch', id: draft.id, edit });
            }}
            onRemove={() => {
              dispatch({ type: 'removePatch', id: draft.id });
            }}
          />
        ))}

        <div>
          <Button
            size="small"
            disabled={locked || state.patches.length >= MAX_PATCHES}
            onClick={() => {
              dispatch({ type: 'addPatch' });
            }}
          >
            Добавить правку
          </Button>
        </div>
      </div>

      {state.submitted && outcome.problems.length > 0 ? (
        <Alert severity="warning" role="alert" className={styles['form__notice']}>
          <ul className={styles['form__problems']}>
            {outcome.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {launch.failure === null ? null : (
        <Alert
          severity={
            launch.failure instanceof ApiError && launch.failure.status === 409
              ? 'warning'
              : 'error'
          }
          role="alert"
          closeText="Закрыть"
          className={styles['form__notice']}
          onClose={launch.dismiss}
        >
          {failureText(launch.failure)}
        </Alert>
      )}

      <div className={styles['form__actions']}>
        <Button
          variant="contained"
          disabled={!canRun}
          aria-disabled={blocked ? true : undefined}
          aria-describedby={hint === null ? undefined : hintId}
          className={
            blocked
              ? `${styles['form__submit']} ${styles['form__submit_waiting']}`
              : styles['form__submit']
          }
          onClick={submit}
        >
          Поставить перепрогон
        </Button>

        {hint === null ? null : (
          <Typography variant="caption" id={hintId} className={styles['form__caption']}>
            {hint}
          </Typography>
        )}
      </div>
    </Paper>
  );
};
