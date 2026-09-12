import Typography from '@mui/material/Typography';
import { SummaryBar } from '../features/topology/components/SummaryBar/SummaryBar.js';
import { TopologyTree } from '../features/topology/components/TopologyTree/TopologyTree.js';
import { useTopologyRows } from '../features/topology/hooks/useTopologyRows.js';
import { EmptyState } from '../shared/ui/EmptyState/EmptyState.js';
import { ErrorState } from '../shared/ui/ErrorState/ErrorState.js';
import { SkeletonBlock } from '../shared/ui/SkeletonBlock/SkeletonBlock.js';

/** Обзор стенда: сводка сверху, дерево объектов ниже. Состояния экрана честные, все четыре. */
export const OverviewPage = (): React.JSX.Element => {
  const { rows, summary, isPending, isError, error, refetch } = useTopologyRows();

  return (
    <>
      <Typography variant="h5" gutterBottom>
        Обзор
      </Typography>

      {isPending ? <SkeletonBlock rows={6} height={48} label="Загружаем стенд" /> : null}

      {isError ? <ErrorState error={error} onRetry={refetch} /> : null}

      {!isPending && !isError && rows.length === 0 ? (
        <EmptyState
          title="Стенд пуст"
          hint="Топология ещё не перенесена в базу. Это делает мигратор при запуске стека."
          actionLabel="Проверить снова"
          onAction={refetch}
        />
      ) : null}

      {!isPending && !isError && rows.length > 0 ? (
        <>
          <SummaryBar summary={summary} />
          <TopologyTree rows={rows} />
        </>
      ) : null}
    </>
  );
};
