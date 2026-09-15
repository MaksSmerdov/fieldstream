import Typography from '@mui/material/Typography';
import { useSearchParams } from 'react-router-dom';
import { hasPermission } from '@fieldstream/contracts';
import { useServerNow } from '../features/lab/hooks/useServerNow.js';
import { ReplayForm } from '../features/replay/components/form/ReplayForm/ReplayForm.js';
import { ReplayResult } from '../features/replay/components/result/ReplayResult/ReplayResult.js';
import { ReplayRunList } from '../features/replay/components/runs/ReplayRunList/ReplayRunList.js';
import { ReplayRunPanel } from '../features/replay/components/runs/ReplayRunPanel/ReplayRunPanel.js';
import { useReplayLaunch } from '../features/replay/hooks/runs/useReplayLaunch.js';
import { useReplayRun } from '../features/replay/hooks/runs/useReplayRun.js';
import { useReplayRuns } from '../features/replay/hooks/runs/useReplayRuns.js';
import { isReplayFinished } from '../features/replay/replay-words.js';
import { ApiError } from '../shared/api/http.js';
import { useSessionStore } from '../shared/auth/session-store.js';
import { EmptyState } from '../shared/ui/EmptyState/EmptyState.js';
import { ErrorBanner } from '../shared/ui/ErrorBanner/ErrorBanner.js';
import { ErrorState } from '../shared/ui/ErrorState/ErrorState.js';
import { SkeletonBlock } from '../shared/ui/SkeletonBlock/SkeletonBlock.js';
import styles from './ReplayPage.module.scss';

/** Прогона по адресу нет: удалён чисткой старых прогонов или адрес неверный. */
const isMissingRun = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 404 || error.status === 400);

/** Перепрогон: правка уставок на сырых кадрах окна, ход прогона и разница срабатываний. */
export const ReplayPage = (): React.JSX.Element => {
  const [params, setParams] = useSearchParams();
  const nowMs = useServerNow();
  const list = useReplayRuns();
  const permissions = useSessionStore((state) => state.user?.permissions);
  const canRun = hasPermission(permissions ?? [], 'replay.run');

  const requested = params.get('run');
  const selectedId = requested ?? list.activeRun?.id ?? list.runs[0]?.id ?? null;
  const listed =
    [list.activeRun, ...list.runs].find((run) => run !== null && run.id === selectedId) ?? null;
  const watch = useReplayRun(selectedId, listed);

  const follow = (runId: string): void => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('run', runId);
        return next;
      },
      { replace: true },
    );
  };
  const launch = useReplayLaunch(follow);

  const busyRun =
    list.activeRun !== null &&
    watch.run !== null &&
    watch.run.id === list.activeRun.id &&
    isReplayFinished(watch.run)
      ? null
      : list.activeRun;

  return (
    <>
      <header className={styles['replay__header']}>
        <Typography variant="h5" component="h1">
          Перепрогон
        </Typography>
        <Typography variant="body2" color="text.secondary" className={styles['replay__intro']}>
          Перепрогон читает сырые кадры окна из брокера и дважды пропускает их через те же правила
          алармов: с текущими уставками и с правкой. Показания при этом не меняются, меняются только
          срабатывания.
        </Typography>
      </header>

      {list.isPending ? (
        <div className={styles['replay__layout']}>
          <SkeletonBlock rows={4} height={96} label="Загружаем перепрогоны" />
          <SkeletonBlock rows={3} height={72} label="Загружаем последние прогоны" />
        </div>
      ) : null}

      {list.isError && !list.hasData ? (
        <ErrorState error={list.error} onRetry={list.refetch} />
      ) : null}

      {list.isError && list.hasData ? (
        <ErrorBanner error={list.error} onRetry={list.refetch} />
      ) : null}

      {list.retentionMs === null ? null : (
        <div className={styles['replay__layout']}>
          <ReplayForm
            canRun={canRun}
            retentionMs={list.retentionMs}
            nowMs={nowMs}
            busyRun={busyRun}
            launch={launch}
          />
          <ReplayRunList runs={list.runs} selectedId={selectedId} onSelect={follow} />
        </div>
      )}

      {list.retentionMs === null || selectedId === null ? null : (
        <div className={styles['replay__run']}>
          {watch.isPending ? (
            <SkeletonBlock rows={2} height={120} label="Загружаем прогон" />
          ) : null}

          {watch.run === null && watch.stopped && isMissingRun(watch.pollError) ? (
            <EmptyState
              title="Прогон не найден"
              hint="Старые перепрогоны удаляются: хранятся только последние."
              actionLabel="Показать последний"
              onAction={() => {
                setParams(new URLSearchParams(), { replace: true });
              }}
            />
          ) : null}

          {watch.run === null && watch.stopped && !isMissingRun(watch.pollError) ? (
            <ErrorState error={watch.pollError} />
          ) : null}

          {watch.run === null && !watch.stopped && watch.pollError !== null ? (
            <>
              <ErrorState error={watch.pollError} />
              <Typography variant="caption" color="text.secondary">
                Прогон спросим снова через секунду.
              </Typography>
            </>
          ) : null}

          {watch.run === null ? null : (
            <>
              <ReplayRunPanel
                run={watch.run}
                nowMs={nowMs}
                retentionMs={list.retentionMs}
                pollError={watch.pollError}
                stopped={watch.stopped}
              />
              {watch.run.status === 'done' ? (
                <ReplayResult key={watch.run.id} run={watch.run} retentionMs={list.retentionMs} />
              ) : null}
            </>
          )}
        </div>
      )}
    </>
  );
};
