import type { ReplayDiffRow } from '@fieldstream/contracts';
import { MODE_LABEL } from '../../../../device/mode-view.js';
import styles from './ReplayDiffTable.module.scss';

interface Props {
  readonly rows: readonly ReplayDiffRow[];
  readonly selectedKey: string | null;
  readonly labelOf: (metricKey: string) => string;
  readonly onSelect: (key: string) => void;
}

/** Ключ строки разницы: прибор, параметр и режим. */
export const rowKeyOf = (row: Pick<ReplayDiffRow, 'deviceCode' | 'metricKey' | 'mode'>): string =>
  `${row.deviceCode}|${row.metricKey}|${row.mode}`;

/** Разница со знаком: ноль остаётся нулём, иначе плюс виден сразу. */
const signed = (value: number, sign: '+' | '−'): string =>
  value === 0 ? '0' : `${sign}${String(value)}`;

/**
 * Таблица разницы срабатываний по прибору, параметру и режиму. Строку можно выбрать: график
 * под таблицей показывает её эпизоды на кривой.
 */
export const ReplayDiffTable = ({
  rows,
  selectedKey,
  labelOf,
  onSelect,
}: Props): React.JSX.Element => (
  <div
    className={styles['diff']}
    role="region"
    aria-label="Таблица разницы срабатываний"
    tabIndex={0}
  >
    <table className={styles['diff__table']}>
      <thead>
        <tr>
          <th scope="col">Прибор</th>
          <th scope="col">Параметр</th>
          <th scope="col">Режим</th>
          <th scope="col" className={styles['diff__number']}>
            Было
          </th>
          <th scope="col" className={styles['diff__number']}>
            Стало
          </th>
          <th scope="col" className={styles['diff__number']}>
            Новые
          </th>
          <th scope="col" className={styles['diff__number']}>
            Пропали
          </th>
          <th scope="col" className={styles['diff__number']}>
            Вживую
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const key = rowKeyOf(row);
          const selected = key === selectedKey;
          const label = labelOf(row.metricKey);

          return (
            <tr key={key} className={selected ? styles['diff__row_selected'] : undefined}>
              <th scope="row">
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={`График: ${row.deviceCode}, ${label}, ${MODE_LABEL[row.mode]}`}
                  className={styles['diff__pick']}
                  onClick={() => {
                    onSelect(key);
                  }}
                >
                  {row.deviceCode}
                </button>
              </th>
              <td className={styles['diff__label']}>{label}</td>
              <td>{MODE_LABEL[row.mode]}</td>
              <td className={styles['diff__number']}>{row.baseline}</td>
              <td className={styles['diff__number']}>{row.patched}</td>
              <td
                className={
                  row.added === 0
                    ? styles['diff__number']
                    : `${styles['diff__number']} ${styles['diff__number_added']}`
                }
              >
                {signed(row.added, '+')}
              </td>
              <td
                className={
                  row.removed === 0
                    ? styles['diff__number']
                    : `${styles['diff__number']} ${styles['diff__number_removed']}`
                }
              >
                {signed(row.removed, '−')}
              </td>
              <td className={styles['diff__number']}>{row.live}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);
