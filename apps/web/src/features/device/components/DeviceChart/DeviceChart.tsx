import { useMemo, useState } from 'react';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import type { ProfileParamView, SeriesMeta } from '@fieldstream/contracts';
import { TimeChart } from '../../../../shared/charts/TimeChart/TimeChart.js';
import type { ChartBand } from '../../../../shared/charts/TimeChart/TimeChart.js';
import { alignSeries } from '../../../../shared/charts/align-series.js';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.js';
import { ErrorState } from '../../../../shared/ui/ErrorState/ErrorState.js';
import { SkeletonBlock } from '../../../../shared/ui/SkeletonBlock/SkeletonBlock.js';
import { MODE_BAND, MODE_LABEL } from '../../mode-view.js';
import { WINDOW_LABEL, useSeriesWindow } from '../../hooks/useSeriesWindow.js';
import type { WindowKey } from '../../hooks/useSeriesWindow.js';
import styles from './DeviceChart.module.scss';

interface Props {
  readonly code: string;
  readonly params: readonly ProfileParamView[];
}

const WINDOWS: readonly WindowKey[] = ['1h', '6h', '24h', '7d'];

/** Больше четырёх кривых на одной шкале уже не читаются, поэтому выбор ограничен. */
const MAX_LINES = 4;

const LINE_COLORS = ['#4f9cf9', '#f2a13a', '#6ddf8f', '#ff7b72'] as const;

const SOURCE_LABEL: Readonly<Record<SeriesMeta['source'], string>> = {
  readings: 'сырые отсчёты',
  readings_1m: 'минутный агрегат',
  readings_1h: 'часовой агрегат',
};

/** Шаг словами: «600000 мс» ничего не говорит, а «10 мин» говорит сразу. */
const stepText = (bucketMs: number): string => {
  if (bucketMs < 60_000) return `${String(Math.round(bucketMs / 1000))} с`;
  if (bucketMs < 3_600_000) return `${String(Math.round(bucketMs / 60_000))} мин`;

  return `${String(Math.round(bucketMs / 3_600_000))} ч`;
};

/**
 * График прибора. Источник данных выбирает не фронт, а сервер, и присылает его вместе с
 * точками: подпись под графиком поэтому не может разойтись с тем, откуда взяты числа.
 * Полоса режимов рисуется на той же канве: оттайка объясняет подъём температуры, и разъезжаться
 * с кривой она не имеет права.
 */
export const DeviceChart = ({ code, params }: Props): React.JSX.Element => {
  const [windowKey, setWindowKey] = useState<WindowKey>('6h');
  const [selected, setSelected] = useState<readonly string[]>(() =>
    params.slice(0, 2).map((param) => param.metricKey),
  );
  const theme = useTheme();

  const series = useSeriesWindow(code, selected, windowKey);

  const byKey = useMemo(() => new Map(params.map((param) => [param.metricKey, param])), [params]);

  const shown = useMemo(
    () =>
      series.metrics.flatMap((metric) => {
        const param = byKey.get(metric.metricKey);

        return param === undefined ? [] : [{ metric, param }];
      }),
    [series.metrics, byKey],
  );

  const data = useMemo(() => alignSeries(shown.map((item) => item.metric)), [shown]);

  const bands = useMemo<ChartBand[]>(
    () =>
      series.spans.flatMap((span) => {
        const color = MODE_BAND[span.mode];

        return color === null
          ? []
          : [{ from: Date.parse(span.from) / 1000, to: Date.parse(span.to) / 1000, color }];
      }),
    [series.spans],
  );

  const modes = useMemo(
    () => [...new Set(series.spans.map((span) => span.mode))].filter((mode) => mode !== 'cooling'),
    [series.spans],
  );

  /** Выбор сдвигается как очередь: достигнутый предел не должен превращать клик в пустоту. */
  const toggle = (metricKey: string): void => {
    setSelected((current) => {
      if (current.includes(metricKey)) return current.filter((key) => key !== metricKey);
      const next = [...current, metricKey];

      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  };

  const ready = !series.isPending && !series.isError;

  return (
    <Paper variant="outlined" className={styles['chart']}>
      <div className={styles['chart__toolbar']}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={windowKey}
          onChange={(_event, value: WindowKey | null) => {
            if (value !== null) setWindowKey(value);
          }}
          aria-label="Окно графика"
        >
          {WINDOWS.map((key) => (
            <ToggleButton key={key} value={key}>
              {WINDOW_LABEL[key]}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        <div className={styles['chart__metrics']}>
          {params.map((param) => (
            <Chip
              key={param.metricKey}
              size="small"
              label={param.label}
              variant={selected.includes(param.metricKey) ? 'filled' : 'outlined'}
              color={selected.includes(param.metricKey) ? 'primary' : 'default'}
              onClick={() => {
                toggle(param.metricKey);
              }}
            />
          ))}
        </div>
      </div>

      {series.isPending ? <SkeletonBlock rows={1} height={280} label="Строим график" /> : null}

      {series.isError ? <ErrorState error={series.error} onRetry={series.refetch} /> : null}

      {ready && selected.length === 0 ? (
        <EmptyState
          title="Метрики не выбраны"
          hint="Отметьте хотя бы одну, чтобы увидеть кривую."
        />
      ) : null}

      {ready && selected.length > 0 && data.xs.length === 0 ? (
        <EmptyState
          title="За это окно данных нет"
          hint="Историю засевает отдельный шаг стенда, а живые значения копятся по мере опроса."
          actionLabel="Повторить"
          onAction={series.refetch}
        />
      ) : null}

      {ready && data.xs.length > 0 ? (
        <>
          <TimeChart
            xs={data.xs}
            ys={data.ys}
            bands={bands}
            theme={theme.palette.mode}
            label={`График прибора ${code} за ${WINDOW_LABEL[windowKey]}`}
            lines={shown.map((item, index) => ({
              label: item.param.label,
              unit: item.param.unit,
              precision: item.param.precision,
              stroke: LINE_COLORS[index % LINE_COLORS.length] ?? LINE_COLORS[0],
            }))}
          />

          <div className={styles['chart__legend']}>
            {shown.map((item, index) => (
              <span key={item.metric.metricKey} className={styles['chart__line']}>
                <i
                  className={styles['chart__swatch']}
                  style={{ background: LINE_COLORS[index % LINE_COLORS.length] }}
                />
                {item.param.label}
                {item.param.unit === null ? '' : `, ${item.param.unit}`}
              </span>
            ))}

            {modes.map((mode) => (
              <span key={mode} className={styles['chart__line']}>
                <i
                  className={styles['chart__swatch']}
                  style={{ background: MODE_BAND[mode] ?? 'transparent' }}
                />
                {MODE_LABEL[mode]}
              </span>
            ))}
          </div>
        </>
      ) : null}

      {series.meta === undefined ? null : (
        <Typography variant="caption" className={styles['chart__source']}>
          источник: {SOURCE_LABEL[series.meta.source]} · шаг {stepText(series.meta.bucketMs)}
          {series.meta.truncated ? ' · окно прорежено под предел точек' : ''}
        </Typography>
      )}
    </Paper>
  );
};
