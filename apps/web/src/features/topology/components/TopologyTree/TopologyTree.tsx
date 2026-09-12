import { useRef } from 'react';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Link as RouterLink } from 'react-router-dom';
import type { Severity } from '@fieldstream/contracts';
import type { TopologyRow } from '../../hooks/useTopologyRows.js';
import { StatusChip } from '../../../../shared/ui/StatusChip/StatusChip.js';
import { ValueCell } from '../../../../shared/ui/ValueCell/ValueCell.js';
import { agoText } from '../../../../shared/time/human-time.js';
import styles from './TopologyTree.module.scss';

interface Props {
  readonly rows: readonly TopologyRow[];
}

const SEVERITY_WORD: Readonly<Record<Severity, string>> = {
  info: 'сообщений',
  warning: 'предупреждений',
  critical: 'критических',
};

/** Высоты рядов заданы: окно прокрутки должно знать размер до отрисовки, иначе список прыгает. */
const ROW_HEIGHT: Readonly<Record<TopologyRow['kind'], number>> = {
  site: 44,
  line: 40,
  device: 52,
};

/**
 * Дерево объектов площадки. Список виртуализирован: раскладка и высоты рядов не зависят
 * от числа приборов, двадцать четыре на стенде или пятьсот.
 */
export const TopologyTree = ({ rows }: Props): React.JSX.Element => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => ROW_HEIGHT[rows[index]?.kind ?? 'device'],
    overscan: 8,
  });

  return (
    <div
      className={styles['tree']}
      ref={scrollRef}
      role="region"
      aria-label="Дерево объектов площадки"
      tabIndex={0}
    >
      <div
        className={styles['tree__canvas']}
        style={{ height: `${String(virtualizer.getTotalSize())}px` }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (row === undefined) return null;

          return (
            <div
              key={row.key}
              className={styles['tree__row']}
              style={{
                height: `${String(item.size)}px`,
                transform: `translateY(${String(item.start)}px)`,
              }}
            >
              {row.kind === 'site' ? (
                <Typography variant="subtitle1" className={styles['tree__site']}>
                  {row.name} <span className={styles['tree__code']}>{row.code}</span>
                </Typography>
              ) : null}

              {row.kind === 'line' ? (
                <div className={styles['tree__line']}>
                  <span className={styles['tree__line-code']}>
                    {row.gatewayCode} · {row.lineCode}
                  </span>
                  <span className={styles['tree__line-meta']}>
                    {row.baud} бод · опрос {Math.round(row.pollIntervalMs / 1000)} с · план{' '}
                    {row.planMode}
                  </span>
                  {row.enabled ? null : (
                    <Chip size="small" label="опрос выключен" color="warning" />
                  )}
                  {row.offline === 0 ? null : (
                    <Chip size="small" label={`нет связи: ${String(row.offline)}`} color="error" />
                  )}
                </div>
              ) : null}

              {row.kind === 'device' ? (
                <div className={styles['tree__device']}>
                  <RouterLink to={`/device/${row.device.code}`} className={styles['tree__link']}>
                    {row.device.code}
                  </RouterLink>
                  <span className={styles['tree__label']}>{row.device.label}</span>
                  <StatusChip
                    status={row.device.status}
                    reason={row.device.reason}
                    since={row.device.since}
                    lastOkAt={row.device.lastOkAt}
                  />
                  <span className={styles['tree__mode']}>{row.device.mode}</span>
                  <span className={styles['tree__age']}>
                    {row.device.stale ? (
                      <ValueCell value={null} stale />
                    ) : (
                      agoText(row.device.staleSince)
                    )}
                  </span>
                  {/* Важность словом, а не только цветом: красное от жёлтого отличают не все */}
                  {row.device.activeAlarms === 0 ? (
                    <span className={styles['tree__alarms-empty']}>алармов нет</span>
                  ) : (
                    <Chip
                      size="small"
                      label={`${SEVERITY_WORD[row.device.worstSeverity ?? 'info']}: ${String(row.device.activeAlarms)}`}
                      color={row.device.worstSeverity === 'critical' ? 'error' : 'warning'}
                    />
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};
