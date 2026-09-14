import { partitionBarShape } from '../../pipeline-geometry.js';
import { numberText } from '../../pipeline-words.js';
import styles from './PartitionBar.module.scss';

interface Props {
  readonly partition: number;
  readonly low: number;
  readonly high: number;
  readonly committed: number | null;
  readonly lag: number | null;
  readonly tone: number | null;
}

/** Описание полосы словами для вспомогательных программ. */
const labelOf = ({ partition, low, high, committed, lag }: Props, emptyLog: boolean): string =>
  [
    emptyLog
      ? `Партиция ${String(partition)}: лог пуст на смещении ${numberText(high)}`
      : `Партиция ${String(partition)}: лог с ${numberText(low)} по ${numberText(high)}`,
    committed === null ? 'коммита не было' : `подтверждено ${numberText(committed)}`,
    lag === null ? null : `отставание ${numberText(lag)}`,
  ]
    .filter((item): item is string => item !== null)
    .join(', ');

/** Классы полосы по виду: без коммита, пустой лог. */
const barClass = (uncommitted: boolean, emptyLog: boolean): string =>
  [
    styles['bar'],
    uncommitted ? styles['bar_uncommitted'] : null,
    emptyLog ? styles['bar_empty'] : null,
  ]
    .filter((item): item is string => item !== null && item !== undefined)
    .join(' ');

/** Полоса лога партиции: прочитанная часть, отметка коммита и заштрихованное отставание. */
export const PartitionBar = (props: Props): React.JSX.Element => {
  const { low, high, committed, tone } = props;
  const shape = partitionBarShape(low, high, committed);
  const toneKey = tone === null ? 'none' : `tone${String(tone)}`;

  return (
    <div
      className={barClass(shape.commitPct === null, shape.emptyLog)}
      role="img"
      aria-label={labelOf(props, shape.emptyLog)}
    >
      {shape.commitPct === null || shape.emptyLog ? null : (
        <>
          <span
            className={`${styles['bar__read']} ${styles[`bar__read_${toneKey}`]}`}
            style={{ width: `${String(shape.commitPct)}%` }}
          />
          <span
            className={`${styles['bar__lag']} ${styles[`bar__lag_${toneKey}`]}`}
            style={{
              left: `${String(shape.lagFromPct)}%`,
              width: `${String(shape.lagWidthPct)}%`,
            }}
          />
          <span className={styles['bar__commit']} style={{ left: `${String(shape.commitPct)}%` }} />
        </>
      )}
    </div>
  );
};
