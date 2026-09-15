import { useId, useMemo } from 'react';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { REPLAY_EPISODES_LIMIT } from '@fieldstream/contracts';
import type {
  ProfileParamView,
  ReplayChangedRule,
  ReplayDiffRow,
  ReplayEpisode,
  ReplayRun,
} from '@fieldstream/contracts';
import { TimeChart } from '../../../../../shared/charts/TimeChart/TimeChart.js';
import type {
  ChartBand,
  ChartThreshold,
} from '../../../../../shared/charts/TimeChart/TimeChart.js';
import { alignSeries } from '../../../../../shared/charts/align-series.js';
import { counted } from '../../../../../shared/text/plural.js';
import { EmptyState } from '../../../../../shared/ui/EmptyState/EmptyState.js';
import { ErrorState } from '../../../../../shared/ui/ErrorState/ErrorState.js';
import { SkeletonBlock } from '../../../../../shared/ui/SkeletonBlock/SkeletonBlock.js';
import { MODE_LABEL } from '../../../../device/mode-view.js';
import { useRowChart } from '../../../hooks/result/useRowChart.js';
import { EPISODE_FORMS, windowText } from '../../../replay-words.js';
import styles from './ReplayRowChart.module.scss';

interface Props {
  readonly run: ReplayRun;
  readonly row: ReplayDiffRow;
  readonly param: ProfileParamView | undefined;
  readonly changedRule: ReplayChangedRule | undefined;
}

const LINE_COLOR = '#4f9cf9';
const BASELINE_BAND = 'rgba(140, 150, 165, 0.6)';
const PATCHED_BAND = 'rgba(255, 123, 114, 0.6)';

/** Узкая карточка итога на ширине 360 px: график не должен вылезать за её рамку. */
const CHART_MIN_WIDTH = 240;

interface ThresholdItem extends ChartThreshold {
  readonly text: string;
}

const BOUND_WORD = { minValue: 'нижняя', maxValue: 'верхняя' } as const;

/** Эпизоды варианта полосами на своей дорожке; открытый к концу окна тянется до конца покрытия. */
const bandsOf = (
  episodes: readonly ReplayEpisode[],
  run: ReplayRun,
  color: string,
  track: 'top' | 'bottom',
): ChartBand[] =>
  episodes.map((episode) => ({
    from: Date.parse(episode.raisedAt) / 1000,
    to: Date.parse(episode.clearedAt ?? run.coveredTo ?? run.to) / 1000,
    color,
    track,
  }));

/** Линии порогов до и после правки; неизменная граница рисуется одной линией. */
const thresholdsOf = (
  rule: ReplayChangedRule | undefined,
  before: string,
  after: string,
): ThresholdItem[] => {
  if (rule === undefined) return [];

  return (['minValue', 'maxValue'] as const).flatMap((field) => {
    const was = rule.baseline[field];
    const now = rule.patched[field];
    const word = BOUND_WORD[field];
    if (was === now) {
      return was === null
        ? []
        : [{ value: was, color: before, dashed: true, text: `${word} граница ${String(was)}` }];
    }

    return [
      ...(was === null
        ? []
        : [
            {
              value: was,
              color: before,
              dashed: true,
              text: `${word} граница до правки ${String(was)}`,
            },
          ]),
      ...(now === null
        ? []
        : [
            {
              value: now,
              color: after,
              dashed: false,
              text: `${word} граница после правки ${String(now)}`,
            },
          ]),
    ];
  });
};

/**
 * График выбранной строки: кривая параметра из базы показаний за окно прогона, эпизоды «было»
 * дорожкой сверху, «стало» дорожкой снизу и линии порогов до и после правки.
 */
export const ReplayRowChart = ({ run, row, param, changedRule }: Props): React.JSX.Element => {
  const titleId = useId();
  const theme = useTheme();
  const data = useRowChart(run, row);
  const label = param?.label ?? row.metricKey;
  const unit = param?.unit ?? null;
  const precision = param?.precision ?? 1;

  const metric = data.series?.metrics.find((item) => item.metricKey === row.metricKey);
  const aligned = useMemo(() => alignSeries(metric === undefined ? [] : [metric]), [metric]);

  const baseline = data.episodes?.baseline ?? [];
  const patched = data.episodes?.patched ?? [];
  const bands = useMemo(
    () => [
      ...bandsOf(data.episodes?.baseline ?? [], run, BASELINE_BAND, 'top'),
      ...bandsOf(data.episodes?.patched ?? [], run, PATCHED_BAND, 'bottom'),
    ],
    [data.episodes, run],
  );
  const thresholds = useMemo(
    () => thresholdsOf(changedRule, theme.palette.text.secondary, theme.palette.error.main),
    [changedRule, theme.palette.text.secondary, theme.palette.error.main],
  );

  const chartLabel = useMemo(() => {
    const values = (metric?.points ?? [])
      .map((point) => point.avg)
      .filter((value): value is number => value !== null);
    const suffix = unit === null ? '' : ` ${unit}`;
    const range =
      values.length === 0
        ? 'Показаний нет'
        : `Значения от ${Math.min(...values).toFixed(precision)} до ${Math.max(...values).toFixed(precision)}${suffix}`;
    const rules =
      thresholds.length === 0
        ? 'Уставка этой строки правкой не менялась'
        : thresholds.map((item) => item.text).join(', ');

    return (
      `График ${row.deviceCode}, ${label}, ${MODE_LABEL[row.mode]} за окно прогона ${windowText(run.from, run.to)}. ` +
      `${range}. Эпизодов с прежними уставками ${String(baseline.length)}, с правкой ${String(patched.length)}. ${rules}.`
    );
  }, [metric, unit, precision, thresholds, row, label, run, baseline.length, patched.length]);

  return (
    <section aria-labelledby={titleId} className={styles['chart']}>
      <Typography variant="subtitle2" component="h3" id={titleId}>
        {`График: ${row.deviceCode} · ${label} · ${MODE_LABEL[row.mode]}`}
      </Typography>

      {data.isPending ? <SkeletonBlock rows={1} height={280} label="Строим график" /> : null}

      {!data.isPending && data.isError ? (
        <ErrorState error={data.error} onRetry={data.refetch} />
      ) : null}

      {!data.isPending && !data.isError && aligned.xs.length === 0 ? (
        <EmptyState
          title="За окно прогона показаний этого параметра в базе нет"
          hint={`Эпизоды посчитаны по сырым кадрам: с прежними уставками ${counted(baseline.length, EPISODE_FORMS)}, с правкой ${counted(patched.length, EPISODE_FORMS)}.`}
          actionLabel="Повторить"
          onAction={data.refetchSeries}
        />
      ) : null}

      {!data.isPending && !data.isError && aligned.xs.length > 0 ? (
        <>
          <TimeChart
            xs={aligned.xs}
            ys={aligned.ys}
            bands={bands}
            thresholds={thresholds}
            theme={theme.palette.mode}
            minWidth={CHART_MIN_WIDTH}
            label={chartLabel}
            lines={[{ label, unit, precision, stroke: LINE_COLOR }]}
          />

          <div className={styles['chart__legend']}>
            <span className={styles['chart__item']}>
              <i className={styles['chart__swatch']} style={{ background: LINE_COLOR }} />
              {unit === null ? label : `${label}, ${unit}`}
            </span>
            <span className={styles['chart__item']}>
              <i className={styles['chart__swatch']} style={{ background: BASELINE_BAND }} />
              {`было, дорожка сверху: ${counted(baseline.length, EPISODE_FORMS)}`}
            </span>
            <span className={styles['chart__item']}>
              <i className={styles['chart__swatch']} style={{ background: PATCHED_BAND }} />
              {`стало, дорожка снизу: ${counted(patched.length, EPISODE_FORMS)}`}
            </span>
            {thresholds.map((item) => (
              <span key={item.text} className={styles['chart__item']}>
                <i
                  className={
                    item.dashed
                      ? `${styles['chart__rule']} ${styles['chart__rule_dashed']}`
                      : styles['chart__rule']
                  }
                  style={{ borderColor: item.color }}
                />
                {item.text}
              </span>
            ))}
            {changedRule === undefined ? (
              <span className={styles['chart__item']}>уставка этой строки правкой не менялась</span>
            ) : null}
            {data.episodes?.truncated === true ? (
              <span className={styles['chart__item']}>
                {`на графике первые ${String(REPLAY_EPISODES_LIMIT)} эпизодов каждого варианта, счёт в таблице полный`}
              </span>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
};
