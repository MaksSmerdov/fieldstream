import Typography from '@mui/material/Typography';
import { SummaryBar } from '../features/topology/components/SummaryBar/SummaryBar.js';
import { TopologyTree } from '../features/topology/components/TopologyTree/TopologyTree.js';
import { useTopologyRows } from '../features/topology/hooks/useTopologyRows.js';
import { EmptyState } from '../shared/ui/EmptyState/EmptyState.js';
import { ErrorBanner } from '../shared/ui/ErrorBanner/ErrorBanner.js';
import { ErrorState } from '../shared/ui/ErrorState/ErrorState.js';
import { SkeletonBlock } from '../shared/ui/SkeletonBlock/SkeletonBlock.js';

/** Обзор стенда: сводка сверху, дерево объектов ниже. Состояния экрана честные, все четыре. */
export const OverviewPage = (): React.JSX.Element => {
  const { rows, summary, hasData, isPending, isError, error, refetch } = useTopologyRows();

  return (
    <>
      <Typography variant="h5" gutterBottom>
        Обзор
      </Typography>

      {isPending ? <SkeletonBlock rows={6} height={48} label="Загружаем стенд" /> : null}

      {isError && !hasData ? <ErrorState error={error} onRetry={refetch} /> : null}

      {isError && hasData ? <ErrorBanner error={error} onRetry={refetch} /> : null}

      {/* Пустота считается по приборам, а не по рядам: площадка с линиями и без единого
          прибора дала бы дерево из одних заголовков, и это выглядело бы поломкой */}
      {!isPending && hasData && summary.devices === 0 ? (
        <EmptyState
          title="Приборов на стенде нет"
          hint="Топология ещё не перенесена в базу. Это делает мигратор при запуске стека."
          actionLabel="Проверить снова"
          onAction={refetch}
        />
      ) : null}

      {!isPending && summary.devices > 0 ? (
        <>
          <SummaryBar summary={summary} />
          <TopologyTree rows={rows} />
        </>
      ) : null}
    </>
  );
};
