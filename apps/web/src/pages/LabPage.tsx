import { useMemo } from 'react';
import Typography from '@mui/material/Typography';
import { useSearchParams } from 'react-router-dom';
import { hasPermission } from '@fieldstream/contracts';
import { ChaosPanel } from '../features/lab/components/ChaosPanel/ChaosPanel.js';
import { LineInstruments } from '../features/lab/components/LineInstruments/LineInstruments.js';
import { ScenarioSection } from '../features/lab/components/scenarios/ScenarioSection/ScenarioSection.js';
import { useLabLines } from '../features/lab/hooks/useLabLines.js';
import { useLabTopology } from '../features/lab/hooks/useLabTopology.js';
import { useServerNow } from '../features/lab/hooks/useServerNow.js';
import { chaosLines, selectDevice } from '../features/lab/lab-lines.js';
import { useSessionStore } from '../shared/auth/session-store.js';
import { EmptyState } from '../shared/ui/EmptyState/EmptyState.js';
import { ErrorBanner } from '../shared/ui/ErrorBanner/ErrorBanner.js';
import { ErrorState } from '../shared/ui/ErrorState/ErrorState.js';
import { SkeletonBlock } from '../shared/ui/SkeletonBlock/SkeletonBlock.js';
import styles from './LabPage.module.scss';

/** Лаборатория отказов: поломки стенда, приборы защитных механизмов сборщика и сценарии стенда. */
export const LabPage = (): React.JSX.Element => {
  const [params, setParams] = useSearchParams();
  const nowMs = useServerNow();
  const snapshots = useLabLines();
  const topology = useLabTopology();
  const permissions = useSessionStore((state) => state.user?.permissions);
  const canInject = hasPermission(permissions ?? [], 'lab.inject');
  const canRun = hasPermission(permissions ?? [], 'scenarios.run');

  const lines = useMemo(
    () => chaosLines(topology.topology, snapshots.lines),
    [topology.topology, snapshots.lines],
  );
  const selected = selectDevice(lines, params.get('device'));
  const snapshot =
    selected === null
      ? undefined
      : snapshots.lines.find((line) => line.lineCode === selected.line.code);

  const select = (code: string): void => {
    const next = new URLSearchParams(params);
    next.set('device', code);
    setParams(next, { replace: true });
  };

  return (
    <>
      <Typography variant="h5" gutterBottom>
        Отказы
      </Typography>

      {snapshots.isPending ? (
        <div className={styles['lab__layout']}>
          <SkeletonBlock rows={5} height={56} label="Загружаем снимки линий" />
          <SkeletonBlock rows={3} height={180} label="Загружаем приборы защиты" />
        </div>
      ) : null}

      {snapshots.isError && !snapshots.hasData ? (
        <ErrorState error={snapshots.error} onRetry={snapshots.refetch} />
      ) : null}

      {snapshots.isError && snapshots.hasData ? (
        <ErrorBanner error={snapshots.error} onRetry={snapshots.refetch} />
      ) : null}

      {snapshots.hasData ? (
        <div className={styles['lab__layout']}>
          <ChaosPanel
            lines={lines}
            selected={selected}
            topology={topology}
            canInject={canInject}
            nowMs={nowMs}
            onSelect={select}
          />

          <div className={styles['lab__instruments']}>
            {snapshots.lines.length === 0 ? (
              <EmptyState
                title="Сборщик ещё не прислал снимки линий"
                hint="Снимок линии приходит после каждого обхода. Если сборщик запущен, приборы защиты появятся здесь через несколько секунд."
                actionLabel="Проверить снова"
                onAction={snapshots.refetch}
              />
            ) : null}

            {snapshots.lines.length > 0 && selected === null ? (
              <EmptyState
                title="На линиях нет приборов"
                hint="Выбрать не из чего: в топологии и снимках линий нет ни одного прибора."
                actionLabel="Проверить снова"
                onAction={snapshots.refetch}
              />
            ) : null}

            {snapshots.lines.length > 0 && selected !== null && snapshot === undefined ? (
              <EmptyState
                title={`По линии ${selected.line.code} снимков нет`}
                hint="Сборщик не присылал снимки этой линии. Выберите прибор на другой линии."
              />
            ) : null}

            {selected !== null && snapshot !== undefined ? (
              <LineInstruments snapshot={snapshot} device={selected.device} nowMs={nowMs} />
            ) : null}
          </div>
        </div>
      ) : null}

      <div className={styles['lab__scenarios']}>
        <ScenarioSection canRun={canRun} nowMs={nowMs} />
      </div>
    </>
  );
};
