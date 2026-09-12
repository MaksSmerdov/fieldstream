import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import styles from './TimeChart.module.scss';

/** Затенённый отрезок времени под кривыми: им рисуются режимы прибора. */
export interface ChartBand {
  readonly from: number;
  readonly to: number;
  readonly color: string;
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
  readonly height?: number;
  readonly label: string;
  /** Тема: цвета осей уезжают на канву, и при смене темы график надо пересобрать. */
  readonly theme: 'light' | 'dark';
}

const PADDING = 8;

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
      ctx.save();
      for (const band of read()) {
        const left = plot.valToPos(band.from, 'x', true);
        const right = plot.valToPos(band.to, 'x', true);
        ctx.fillStyle = band.color;
        ctx.fillRect(left, plot.bbox.top, Math.max(1, right - left), plot.bbox.height);
      }
      ctx.restore();
    },
  },
});

/**
 * Обёртка uPlot. Держит один экземпляр графика на всё время жизни набора кривых: на живом
 * экране пересоздание обошлось бы дороже самой отрисовки.
 */
export const TimeChart = ({
  xs,
  ys,
  lines,
  bands,
  height = 280,
  label,
  theme,
}: Props): React.JSX.Element => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const bandsRef = useRef<readonly ChartBand[]>(bands);
  bandsRef.current = bands;

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
        width: Math.max(320, host.clientWidth),
        height,
        padding: [PADDING, PADDING, 0, 0],
        legend: { show: false },
        cursor: { drag: { x: false, y: false } },
        scales: { x: { time: true } },
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
        plugins: [bandsPlugin(() => bandsRef.current)],
      },
      dataRef.current,
      host,
    );
    plotRef.current = plot;

    const observer = new ResizeObserver(() => {
      plot.setSize({ width: Math.max(320, host.clientWidth), height });
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- график пересобирается по составу кривых, а не по ссылке на массив
  }, [shape, height, theme]);

  useEffect(() => {
    plotRef.current?.setData(dataRef.current);
  }, [xs, ys, bands]);

  return <div className={styles['chart']} ref={hostRef} role="img" aria-label={label} />;
};
