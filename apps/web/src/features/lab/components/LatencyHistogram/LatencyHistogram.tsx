import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { LatencyWindow } from '@fieldstream/contracts';
import { counted } from '../../../../shared/text/plural.js';
import { durationText } from '../../lab-format.js';
import {
  HISTOGRAM_BOX,
  histogramBars,
  histogramMarkers,
  samplesMissing,
} from '../../lab-geometry.js';
import type { HistogramBar, MarkerKind } from '../../lab-geometry.js';
import styles from './LatencyHistogram.module.scss';

interface Props {
  readonly lineCode: string;
  readonly latency: LatencyWindow;
  readonly requestTimeoutMs: number;
}

const MARKER_LABEL: Readonly<Record<MarkerKind, string>> = {
  p50: 'p50',
  p95: 'p95',
  p99: 'p99',
  suggested: 'совет',
  timeout: 'таймаут',
};

const SAMPLES_DATIVE: readonly [string, string, string] = ['замеру', 'замерам', 'замерам'];
const SAMPLES_GENITIVE: readonly [string, string, string] = ['замера', 'замеров', 'замеров'];

/** Подпись корзины: верхняя граница или «больше» для последней. */
const bucketText = (bar: HistogramBar): string =>
  bar.toMs === null ? `>${bar.fromMs}` : String(bar.toMs);

/** Строка про рекомендуемый таймаут. */
const suggestionText = (latency: LatencyWindow): string => {
  if (latency.suggestedTimeoutMs !== null) {
    return `рекомендуемый таймаут ${durationText(latency.suggestedTimeoutMs)}`;
  }
  const missing = samplesMissing(latency.samples);

  return missing > 0
    ? `рекомендации таймаута пока нет: не хватает ещё ${counted(missing, SAMPLES_GENITIVE)}`
    : 'рекомендации таймаута нет';
};

/** Подпись графика для вспомогательных программ. */
const chartLabel = (lineCode: string, latency: LatencyWindow, requestTimeoutMs: number): string =>
  [
    `Гистограмма времени ответа линии ${lineCode} по ${counted(latency.samples, SAMPLES_DATIVE)}`,
    latency.p50Ms === null ? null : `p50 ${durationText(latency.p50Ms)}`,
    latency.p95Ms === null ? null : `p95 ${durationText(latency.p95Ms)}`,
    latency.p99Ms === null ? null : `p99 ${durationText(latency.p99Ms)}`,
    `таймаут запроса ${durationText(requestTimeoutMs)}`,
    suggestionText(latency),
  ]
    .filter((part): part is string => part !== null)
    .join(', ');

/** Гистограмма времени ответа линии с перцентилями и таймаутами. */
export const LatencyHistogram = ({
  lineCode,
  latency,
  requestTimeoutMs,
}: Props): React.JSX.Element => {
  const bars = histogramBars(latency);
  const markers = histogramMarkers(latency, requestTimeoutMs);
  const baseline = HISTOGRAM_BOX.height - HISTOGRAM_BOX.bottom;
  const maxCount = Math.max(0, ...latency.counts);

  return (
    <Paper variant="outlined" className={styles['histogram']}>
      <div className={styles['histogram__head']}>
        <Typography variant="subtitle2" component="h3">
          Время ответа
        </Typography>
        <Typography variant="caption" color="text.secondary" className={styles['histogram__count']}>
          {`по ${counted(latency.samples, SAMPLES_DATIVE)}, таймаутов ${latency.timeouts}`}
        </Typography>
      </div>

      {latency.samples === 0 ? (
        <div className={styles['histogram__empty']}>
          <Typography variant="subtitle2">Замеров времени ответа ещё нет</Typography>
          <Typography variant="body2" color="text.secondary">
            {latency.timeouts > 0
              ? 'Все запросы в окне закончились таймаутом: прибору или порту есть что проверить.'
              : 'Линия ещё не ответила ни на один запрос в окне замеров.'}
          </Typography>
        </div>
      ) : (
        <>
          <div className={styles['histogram__scroll']}>
            <svg
              className={styles['histogram__chart']}
              viewBox={`0 0 ${HISTOGRAM_BOX.width} ${HISTOGRAM_BOX.height}`}
              role="img"
              aria-label={chartLabel(lineCode, latency, requestTimeoutMs)}
            >
              <line
                className={styles['histogram__axis']}
                x1={HISTOGRAM_BOX.left}
                x2={HISTOGRAM_BOX.width - HISTOGRAM_BOX.right}
                y1={baseline}
                y2={baseline}
              />
              <text
                className={styles['histogram__tick']}
                x={HISTOGRAM_BOX.left - 6}
                y={HISTOGRAM_BOX.top + 4}
                textAnchor="end"
              >
                {String(maxCount)}
              </text>
              <text
                className={styles['histogram__tick']}
                x={HISTOGRAM_BOX.left - 6}
                y={baseline}
                textAnchor="end"
              >
                0
              </text>

              {bars.map((bar) => (
                <g key={bar.index}>
                  <rect
                    className={styles[bar.toMs === null ? 'histogram__bar_over' : 'histogram__bar']}
                    x={bar.x}
                    y={bar.y}
                    width={bar.width}
                    height={bar.height}
                  >
                    <title>
                      {bar.toMs === null
                        ? `дольше ${durationText(bar.fromMs)}: ${bar.count}`
                        : `до ${durationText(bar.toMs)}: ${bar.count}`}
                    </title>
                  </rect>
                  <text
                    className={styles['histogram__tick']}
                    x={bar.x + bar.width / 2}
                    y={HISTOGRAM_BOX.height - 12}
                    textAnchor="middle"
                  >
                    {bucketText(bar)}
                  </text>
                </g>
              ))}

              {markers.map((marker) => (
                <g key={marker.kind}>
                  <line
                    className={styles[`histogram__marker_${marker.kind}`]}
                    x1={marker.x}
                    x2={marker.x}
                    y1={marker.labelY + 3}
                    y2={baseline}
                  />
                  <text
                    className={styles[`histogram__label_${marker.kind}`]}
                    x={marker.labelX}
                    y={marker.labelY}
                    textAnchor="middle"
                  >
                    {marker.clamped ? `${MARKER_LABEL[marker.kind]} ›` : MARKER_LABEL[marker.kind]}
                  </text>
                </g>
              ))}
            </svg>
          </div>

          <ul className={styles['histogram__legend']}>
            {latency.p50Ms === null ? null : <li>{`p50 ${durationText(latency.p50Ms)}`}</li>}
            {latency.p95Ms === null ? null : <li>{`p95 ${durationText(latency.p95Ms)}`}</li>}
            {latency.p99Ms === null ? null : <li>{`p99 ${durationText(latency.p99Ms)}`}</li>}
            <li className={styles['histogram__legend-timeout']}>
              {`текущий таймаут запроса ${durationText(requestTimeoutMs)}`}
            </li>
            <li className={styles['histogram__legend-suggested']}>{suggestionText(latency)}</li>
          </ul>
        </>
      )}
    </Paper>
  );
};
