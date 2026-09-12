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
    return (
      <Tooltip title={stale ? 'данные устарели' : 'значение недостоверно'} arrow>
        <span className={styles['value_stale']}>{DASH}</span>
      </Tooltip>
    );
  }

  if (states != null) {
    const text = states[String(value)];

    return <span className={styles['value']}>{text ?? String(value)}</span>;
  }

  const shown = value.toFixed(precision);
  const title = quality === 'substituted' ? 'значение подставлено фильтром скачков' : '';

  return (
    <Tooltip title={title} arrow disableHoverListener={title === ''}>
      <span className={quality === 'substituted' ? styles['value_substituted'] : styles['value']}>
        {shown}
        {unit == null ? '' : ` ${unit}`}
      </span>
    </Tooltip>
  );
};
