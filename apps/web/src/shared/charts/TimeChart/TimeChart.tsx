import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import styles from './TimeChart.module.scss';

/**
 * Затенённый отрезок времени под кривыми: им рисуются режимы прибора. Без дорожки полоса
 * занимает всю высоту, с дорожкой только узкую полосу сверху или снизу.
 */
export interface ChartBand {
  readonly from: number;
  readonly to: number;
  readonly color: string;
  readonly track?: 'top' | 'bottom';
}

/** Горизонтальная линия порога поверх кривых. */
export interface ChartThreshold {
  readonly value: number;
  readonly color: string;
  readonly dashed: boolean;
}

export interface ChartLine {
  readonly label: string;
  readonly unit: string | null;
  readonly stroke: string;
  readonly precision: number;
}

interface Props {
  readonly xs: readonly number[];
  readonly ys: readonly (number | null)[][];
  readonly lines: readonly ChartLine[];
  readonly bands: readonly ChartBand[];
  /** Пороги: шкала значений расширяется так, чтобы линии были видны. */
  readonly thresholds?: readonly ChartThreshold[];
  readonly height?: number;
  /** Наименьшая ширина канвы: уже её график не сжимается. */
  readonly minWidth?: number;
  readonly label: string;
  /** Тема: цвета осей уезжают на канву, и при смене темы график надо пересобрать. */
  readonly theme: 'light' | 'dark';
}

const PADDING = 8;

/** Высота дорожки полосы в пикселях экрана. */
const TRACK_HEIGHT = 12;

const HOURS = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const DAYS = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' });

/** Подписи времени по-русски и в двадцатичетырёхчасовом виде: uPlot по умолчанию ставит am/pm. */
const timeLabels = (plot: uPlot, splits: number[]): string[] => {
  const min = plot.scales['x']?.min ?? 0;
  const max = plot.scales['x']?.max ?? 0;
  const format = max - min > 2 * 86_400 ? DAYS : HOURS;

  return splits.map((seconds) => format.format(new Date(seconds * 1000)));
};

/** Цвета осей берутся из темы: график рисуется на канве и сам про смену темы не узнает. */
const tokenOf = (host: HTMLElement, name: string, fallback: string): string => {
  const value = getComputedStyle(host).getPropertyValue(name).trim();

  return value.length === 0 ? fallback : value;
};

/**
 * Полосы режимов. Рисуются прямо на канве после очистки и до кривых: ширину оси значений uPlot
 * считает сам, и отдельная полоска под графиком разъехалась бы с ним по горизонтали.
 */
const bandsPlugin = (read: () => readonly ChartBand[]): uPlot.Plugin => ({
  hooks: {
    drawClear: (plot: uPlot) => {
      const { ctx } = plot;
      const { top, height } = plot.bbox;
      const track = Math.min(height, Math.round(TRACK_HEIGHT * uPlot.pxRatio));
      ctx.save();
      for (const band of read()) {
        const left = plot.valToPos(band.from, 'x', true);
        const right = plot.valToPos(band.to, 'x', true);
        const y = band.track === 'bottom' ? top + height - track : top;
        ctx.fillStyle = band.color;
        ctx.fillRect(left, y, Math.max(1, right - left), band.track === undefined ? height : track);
      }
      ctx.restore();
    },
  },
});

/** Линии порогов рисуются после кривых, чтобы кривая их не закрывала. */
const thresholdsPlugin = (read: () => readonly ChartThreshold[]): uPlot.Plugin => ({
  hooks: {
    draw: (plot: uPlot) => {
      const { ctx } = plot;
      const { left, top, width, height } = plot.bbox;
      ctx.save();
      ctx.lineWidth = 1.5 * uPlot.pxRatio;
      for (const threshold of read()) {
        const y = plot.valToPos(threshold.value, 'y', true);
        if (!Number.isFinite(y) || y < top || y > top + height) continue;
        ctx.strokeStyle = threshold.color;
        ctx.setLineDash(threshold.dashed ? [6 * uPlot.pxRatio, 4 * uPlot.pxRatio] : []);
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + width, y);
        ctx.stroke();
      }
      ctx.restore();
    },
  },
});

/** Пределы шкалы значений вместе с порогами: иначе порог за пределами кривой не виден. */
const rangeWith = (
  thresholds: readonly ChartThreshold[],
  min: number | null,
  max: number | null,
): uPlot.Range.MinMax => {
  const values = [min, max, ...thresholds.map((threshold) => threshold.value)].filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (values.length === 0) return [null, null];

  return uPlot.rangeNum(Math.min(...values), Math.max(...values), 0.1, true);
};

/**
 * Обёртка uPlot. Держит один экземпляр графика на всё время жизни набора кривых: на живом
 * экране пересоздание обошлось бы дороже самой отрисовки.
 */
export const TimeChart = ({
  xs,
  ys,
  lines,
  bands,
  thresholds,
  height = 280,
  minWidth = 320,
  label,
  theme,
}: Props): React.JSX.Element => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const bandsRef = useRef<readonly ChartBand[]>(bands);
  bandsRef.current = bands;
  const thresholdsRef = useRef<readonly ChartThreshold[]>(thresholds ?? []);
  thresholdsRef.current = thresholds ?? [];
  const withThresholds = thresholds !== undefined;

  /** Данные держатся в ссылке: пересозданный график обязан родиться сразу с ними, а не пустым. */
  const dataRef = useRef<uPlot.AlignedData>([[], []]);
  dataRef.current = [[...xs], ...ys.map((column) => [...column])] as uPlot.AlignedData;

  const shape = lines.map((line) => `${line.label}:${line.stroke}`).join('|');

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const axisColor = tokenOf(host, '--mui-palette-text-secondary', '#8a97a8');
    const gridColor = tokenOf(host, '--mui-palette-divider', 'rgba(140, 150, 165, 0.2)');

    const plot = new uPlot(
      {
        width: Math.max(minWidth, host.clientWidth),
        height,
        padding: [PADDING, PADDING, 0, 0],
        legend: { show: false },
        cursor: { drag: { x: false, y: false } },
        scales: withThresholds
          ? {
              x: { time: true },
              y: {
                range: (_plot: uPlot, min: number, max: number) =>
                  rangeWith(thresholdsRef.current, min, max),
              },
            }
          : { x: { time: true } },
        axes: [
          {
            stroke: axisColor,
            grid: { stroke: gridColor, width: 1 },
            ticks: { stroke: gridColor },
            values: timeLabels,
          },
          {
            stroke: axisColor,
            grid: { stroke: gridColor, width: 1 },
            ticks: { stroke: gridColor },
            size: 56,
          },
        ],
        series: [
          {},
          ...lines.map((line) => ({
            label: line.label,
            stroke: line.stroke,
            width: 1.6,
            spanGaps: false,
            value: (_plot: uPlot, value: number | null): string =>
              value === null ? '–' : `${value.toFixed(line.precision)}${line.unit ?? ''}`,
          })),
        ],
        plugins: [
          bandsPlugin(() => bandsRef.current),
          ...(withThresholds ? [thresholdsPlugin(() => thresholdsRef.current)] : []),
        ],
      },
      dataRef.current,
      host,
    );
    plotRef.current = plot;

    const observer = new ResizeObserver(() => {
      plot.setSize({ width: Math.max(minWidth, host.clientWidth), height });
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- график пересобирается по составу кривых, а не по ссылке на массив
  }, [shape, height, minWidth, theme, withThresholds]);

  useEffect(() => {
    plotRef.current?.setData(dataRef.current);
  }, [xs, ys, bands, thresholds]);

  return <div className={styles['chart']} ref={hostRef} role="img" aria-label={label} />;
};
