import { useMemo } from 'react';
import Typography from '@mui/material/Typography';
import { useParams } from 'react-router-dom';
import { DeviceChart } from '../features/device/components/DeviceChart/DeviceChart.js';
import { DeviceHeader } from '../features/device/components/DeviceHeader/DeviceHeader.js';
import { DeviceValues } from '../features/device/components/DeviceValues/DeviceValues.js';
import { useDeviceScreen } from '../features/device/hooks/useDeviceScreen.js';
import { EmptyState } from '../shared/ui/EmptyState/EmptyState.js';
import { ErrorState } from '../shared/ui/ErrorState/ErrorState.js';
import { SkeletonBlock } from '../shared/ui/SkeletonBlock/SkeletonBlock.js';

/** Экран прибора: шапка с состоянием, график с полосой режимов и значения по секциям. */
export const DevicePage = (): React.JSX.Element => {
  const { code = '' } = useParams();
  const { snapshot, profile, isPending, isError, error, refetch } = useDeviceScreen(code);

  /** На графике только числовые параметры: перечисления и слово аварий кривой не рисуются. */
  const plotted = useMemo(
    () =>
      (profile?.sections ?? []).flatMap((section) =>
        section.params.filter((param) => param.kind === 'number'),
      ),
    [profile],
  );

  if (isPending) return <SkeletonBlock rows={4} height={72} label="Загружаем прибор" />;

  if (isError) return <ErrorState error={error} onRetry={refetch} />;

  if (snapshot === undefined || profile === undefined) {
    return (
      <EmptyState
        title={`Прибор ${code} не найден`}
        hint="Код мог измениться вместе с топологией стенда."
        actionLabel="Проверить снова"
        onAction={refetch}
      />
    );
  }

  return (
    <>
      <DeviceHeader snapshot={snapshot} />

      {plotted.length === 0 ? (
        <EmptyState
          title="Числовых параметров у модели нет"
          hint="Графику нечего рисовать: у прибора только состояния и слово аварий."
        />
      ) : (
        <DeviceChart code={code} params={plotted} />
      )}

      <Typography variant="subtitle1" gutterBottom>
        Значения
      </Typography>
      <DeviceValues profile={profile} snapshot={snapshot} />
    </>
  );
};
