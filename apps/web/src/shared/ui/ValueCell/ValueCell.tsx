import Tooltip from '@mui/material/Tooltip';
import type { Quality } from '@fieldstream/contracts';
import styles from './ValueCell.module.scss';

interface Props {
  readonly value: number | null;
  readonly unit?: string | null;
  readonly precision?: number;
  readonly quality?: Quality;
  readonly stale?: boolean;
  /** Словарь состояний: перечисление показывается словом, а не кодом. */
  readonly states?: Readonly<Record<string, string>> | null;
}

const DASH = '–';

/**
 * Значение прибора. Протухшее значение рисуется прочерком, а не последним известным числом:
 * старое число выглядит как правда и вводит в заблуждение сильнее, чем честный прочерк.
 * Причина прочерка лежит рядом невидимым текстом: подсказка по наведению есть только у мыши.
 */
export const ValueCell = ({
  value,
  unit,
  precision = 1,
  quality = 'ok',
  stale = false,
  states,
}: Props): React.JSX.Element => {
  if (value === null || stale || quality === 'bad') {
    const reason = stale ? 'данные устарели' : 'значение недостоверно';

    return (
      <Tooltip title={reason} arrow describeChild>
        <span className={styles['value_stale']}>
          {DASH}
          <span className={styles['value__aside']}>{reason}</span>
        </span>
      </Tooltip>
    );
  }

  if (states != null) {
    const text = states[String(value)];

    return <span className={styles['value']}>{text ?? String(value)}</span>;
  }

  const shown = `${value.toFixed(precision)}${unit == null ? '' : ` ${unit}`}`;

  if (quality !== 'substituted') return <span className={styles['value']}>{shown}</span>;

  return (
    <Tooltip title="значение подставлено фильтром скачков" arrow describeChild>
      <span className={styles['value_substituted']}>
        {shown}
        <span className={styles['value__aside']}>подставлено фильтром скачков</span>
      </span>
    </Tooltip>
  );
};
