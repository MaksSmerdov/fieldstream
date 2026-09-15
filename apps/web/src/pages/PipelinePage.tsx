import Typography from '@mui/material/Typography';
import { hasPermission } from '@fieldstream/contracts';
import { DlqCard } from '../features/pipeline/components/DlqCard/DlqCard.js';
import { GroupCard } from '../features/pipeline/components/GroupCard/GroupCard.js';
import { LagHistoryPanel } from '../features/pipeline/components/LagHistoryPanel/LagHistoryPanel.js';
import { PipelineHeader } from '../features/pipeline/components/PipelineHeader/PipelineHeader.js';
import { PipelineMap } from '../features/pipeline/components/PipelineMap/PipelineMap.js';
import { RebalanceLog } from '../features/pipeline/components/RebalanceLog/RebalanceLog.js';
import { TopicTable } from '../features/pipeline/components/TopicTable/TopicTable.js';
import { useLagHistory } from '../features/pipeline/hooks/useLagHistory.js';
import { usePipelineSnapshot } from '../features/pipeline/hooks/usePipelineSnapshot.js';
import { useSessionStore } from '../shared/auth/session-store.js';
import { EmptyState } from '../shared/ui/EmptyState/EmptyState.js';
import { ErrorBanner } from '../shared/ui/ErrorBanner/ErrorBanner.js';
import { ErrorState } from '../shared/ui/ErrorState/ErrorState.js';
import { SkeletonBlock } from '../shared/ui/SkeletonBlock/SkeletonBlock.js';
import styles from './PipelinePage.module.scss';

/** Конвейер: группы потребителей, отставание по партициям, очередь недоставленных. */
export const PipelinePage = (): React.JSX.Element => {
  const { data, hasData, isPending, isError, error, refetch } = usePipelineSnapshot();
  const history = useLagHistory(data);
  const permissions = useSessionStore((state) => state.user?.permissions);
  const canRedrive = hasPermission(permissions ?? [], 'pipeline.control');

  return (
    <>
      <PipelineHeader
        hasData={hasData}
        sampledAt={data?.sampledAt ?? null}
        brokerError={data?.brokerError ?? null}
      />

      {isPending ? <SkeletonBlock rows={4} height={160} label="Загружаем конвейер" /> : null}

      {isError && !hasData ? <ErrorState error={error} onRetry={refetch} /> : null}

      {isError && hasData ? <ErrorBanner error={error} onRetry={refetch} /> : null}

      {data === undefined ? null : (
        <div className={styles['pipeline']}>
          <PipelineMap data={data} history={history} />

          <section aria-labelledby="pipeline-groups" className={styles['pipeline__section']}>
            <Typography
              id="pipeline-groups"
              variant="subtitle1"
              component="h2"
              className={styles['pipeline__heading']}
            >
              Группы потребителей
            </Typography>

            {data.groups.length === 0 ? (
              <EmptyState
                title={data.sampledAt === null ? 'Брокер ещё не опрошен' : 'Потребителей пока нет'}
                hint={
                  data.sampledAt === null
                    ? 'Шлюз собирает первый снимок брокера. Экран обновляется сам каждые 2 секунды.'
                    : 'Стенд ещё не поднял потребителей: процессор и шлюз заводят свои группы при запуске.'
                }
                actionLabel="Проверить снова"
                onAction={refetch}
              />
            ) : (
              <div className={styles['pipeline__groups']}>
                {data.groups.map((group) => (
                  <GroupCard key={group.groupId} group={group} topics={data.topics} />
                ))}
              </div>
            )}
          </section>

          <div className={styles['pipeline__pair']}>
            <LagHistoryPanel
              groupIds={data.groups.map((group) => group.groupId)}
              history={history}
            />
            <RebalanceLog rebalances={data.rebalances} />
          </div>

          <TopicTable topics={data.topics} />

          <DlqCard dlq={data.dlq} canRedrive={canRedrive} />
        </div>
      )}
    </>
  );
};
