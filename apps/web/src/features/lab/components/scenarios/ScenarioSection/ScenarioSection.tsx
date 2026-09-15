import { useId, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Typography from '@mui/material/Typography';
import { EmptyState } from '../../../../../shared/ui/EmptyState/EmptyState.js';
import { ErrorBanner } from '../../../../../shared/ui/ErrorBanner/ErrorBanner.js';
import { ErrorState } from '../../../../../shared/ui/ErrorState/ErrorState.js';
import { SkeletonBlock } from '../../../../../shared/ui/SkeletonBlock/SkeletonBlock.js';
import { useScenarioRun } from '../../../hooks/scenarios/useScenarioRun.js';
import { useScenarios } from '../../../hooks/scenarios/useScenarios.js';
import { ScenarioCard } from '../ScenarioCard/ScenarioCard.js';
import { ScenarioConfirm } from '../ScenarioConfirm/ScenarioConfirm.js';
import { ScenarioRunPanel } from '../ScenarioRunPanel/ScenarioRunPanel.js';
import styles from './ScenarioSection.module.scss';

interface Props {
  readonly canRun: boolean;
  readonly nowMs: number;
}

interface ConfirmState {
  readonly name: string;
  readonly open: boolean;
}

const CLOSED: ConfirmState = { name: '', open: false };

/** Сценарии стенда: карточки с последними прогонами, запуск с подтверждением и ход прогона. */
export const ScenarioSection = ({ canRun, nowMs }: Props): React.JSX.Element => {
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const list = useScenarios();
  const watch = useScenarioRun(list.activeRun);
  const [confirm, setConfirm] = useState<ConfirmState>(CLOSED);
  const confirming = list.scenarios.find((scenario) => scenario.name === confirm.name) ?? null;
  const busy = watch.activeRun !== null || watch.launching !== null;
  const progressShown =
    watch.run !== null && !watch.stopped && watch.run.id === watch.activeRun?.id;

  const close = (): void => {
    setConfirm((current) => ({ ...current, open: false }));
  };

  return (
    <section className={styles['scenarios']} aria-labelledby={titleId}>
      <div className={styles['scenarios__head']}>
        <Typography
          ref={headingRef}
          variant="h6"
          component="h2"
          id={titleId}
          tabIndex={-1}
          className={styles['scenarios__title']}
        >
          Сценарии
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Сценарий по шагам вносит поломки, проверяет реакцию стенда и снимает поломки. Такие же
          прогоны запускают проверки CI.
        </Typography>
      </div>

      {list.isPending ? <SkeletonBlock rows={2} height={180} label="Загружаем сценарии" /> : null}

      {list.isError && !list.hasData ? (
        <ErrorState error={list.error} onRetry={list.refetch} />
      ) : null}

      {list.isError && list.hasData ? (
        <ErrorBanner error={list.error} onRetry={list.refetch} />
      ) : null}

      {list.hasData && !canRun ? (
        <Alert severity="info" role="note" className={styles['scenarios__notice']}>
          Запускать сценарии может инженер. Здесь видно, как идут прогоны и чем они закончились.
        </Alert>
      ) : null}

      {watch.run === null ? null : (
        <ScenarioRunPanel
          run={watch.run}
          nowMs={nowMs}
          pollError={watch.pollError}
          stopped={watch.stopped}
          onDismiss={() => {
            watch.dismissRun();
            headingRef.current?.focus();
          }}
        />
      )}

      {list.hasData && list.scenarios.length === 0 ? (
        <EmptyState
          title="Сценариев нет"
          hint="В каталоге шлюза нет ни одного описания сценария. Карточки появятся здесь, когда файлы сценариев окажутся в каталоге."
          actionLabel="Перечитать сценарии"
          onAction={list.refetch}
        />
      ) : null}

      {list.scenarios.length === 0 ? null : (
        <div className={styles['scenarios__grid']}>
          {list.scenarios.map((scenario) => (
            <ScenarioCard
              key={scenario.name}
              scenario={scenario}
              canRun={canRun}
              busy={busy}
              activeRun={watch.activeRun}
              progressShown={progressShown}
              launching={watch.launching === scenario.name}
              failure={
                watch.launchFailure?.name === scenario.name ? watch.launchFailure.error : null
              }
              onRun={() => {
                setConfirm({ name: scenario.name, open: true });
              }}
              onDismissFailure={watch.dismissFailure}
            />
          ))}
        </div>
      )}

      <ScenarioConfirm
        scenario={confirming}
        open={confirm.open}
        onCancel={close}
        onConfirm={(name) => {
          close();
          watch.launch(name);
        }}
      />
    </section>
  );
};
