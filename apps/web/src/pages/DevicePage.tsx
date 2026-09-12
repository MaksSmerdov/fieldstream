import { useMemo, useState } from 'react';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import { useParams } from 'react-router-dom';
import { DeviceChart } from '../features/device/components/DeviceChart/DeviceChart.js';
import { DeviceHeader } from '../features/device/components/DeviceHeader/DeviceHeader.js';
import { DeviceValues } from '../features/device/components/DeviceValues/DeviceValues.js';
import { ReadPlanCard } from '../features/device/components/ReadPlanCard/ReadPlanCard.js';
import { RulesPanel } from '../features/rules/components/RulesPanel/RulesPanel.js';
import { useDeviceScreen } from '../features/device/hooks/useDeviceScreen.js';
import { EmptyState } from '../shared/ui/EmptyState/EmptyState.js';
import { ErrorState } from '../shared/ui/ErrorState/ErrorState.js';
import { SkeletonBlock } from '../shared/ui/SkeletonBlock/SkeletonBlock.js';
import styles from './DevicePage.module.scss';

type Panel = 'values' | 'rules' | 'plan';

/**
 * Экран прибора: шапка и график всегда сверху, остальное по вкладкам. Уставки и карта
 * регистров запрашиваются только при открытии своей вкладки: на экране они нужны редко,
 * а запрос при каждом заходе на прибор стоил бы дороже.
 */
export const DevicePage = (): React.JSX.Element => {
  const { code = '' } = useParams();
  const [panel, setPanel] = useState<Panel>('values');
  const { snapshot, profile, isPending, isError, error, refetch } = useDeviceScreen(code);

  /** Подписи параметров для уставок и карты регистров: в них едут только машинные ключи. */
  const labels = useMemo(
    () =>
      Object.fromEntries(
        (profile?.sections ?? []).flatMap((section) =>
          section.params.map((param) => [param.metricKey, param.label]),
        ),
      ),
    [profile],
  );

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

      <Tabs
        value={panel}
        variant="scrollable"
        allowScrollButtonsMobile
        onChange={(_event, value: Panel) => {
          setPanel(value);
        }}
        className={styles['device__tabs']}
      >
        <Tab label="Значения" value="values" />
        <Tab label="Уставки" value="rules" />
        <Tab label="Карта регистров" value="plan" />
      </Tabs>

      {panel === 'values' ? <DeviceValues profile={profile} snapshot={snapshot} /> : null}
      {/* Ключ по прибору: черновики правок живут внутри панели, и без пересоздания они
          переехали бы на соседний прибор вместе с открытой вкладкой */}
      {panel === 'rules' ? <RulesPanel key={code} code={code} labels={labels} /> : null}
      {panel === 'plan' ? <ReadPlanCard code={code} labels={labels} /> : null}
    </>
  );
};
