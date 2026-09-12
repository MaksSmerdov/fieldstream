import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { AlarmRuleAuditEntry } from '@fieldstream/contracts';
import { MODE_LABEL } from '../../../device/mode-view.js';
import { momentText } from '../../../../shared/time/human-time.js';
import styles from './RulesAudit.module.scss';

interface Props {
  readonly items: readonly AlarmRuleAuditEntry[];
  readonly labels: Readonly<Record<string, string>>;
}

const FIELD_LABEL: Readonly<Record<string, string>> = {
  minValue: 'нижняя граница',
  maxValue: 'верхняя граница',
  hysteresis: 'гистерезис',
  debounceCycles: 'такты',
  severity: 'важность',
  enabled: 'включена',
};

const WORDS: Readonly<Record<string, string>> = {
  info: 'сообщение',
  warning: 'предупреждение',
  critical: 'критическая',
  true: 'да',
  false: 'нет',
};

/** Значение поля словами: пустая граница это «нет», а не пустое место в строке журнала. */
const valueText = (value: number | string | boolean | null): string => {
  if (value === null) return 'нет';

  return WORDS[String(value)] ?? String(value);
};

/**
 * Журнал правок уставок. Показываются прежнее и новое значение каждого поля: запись
 * «уставка изменена» не позволяет понять, что именно произошло, а именно за этим в журнал
 * и приходят.
 */
export const RulesAudit = ({ items, labels }: Props): React.JSX.Element => (
  <Paper variant="outlined" className={styles['audit']}>
    <Typography variant="subtitle2" className={styles['audit__title']}>
      Журнал правок
    </Typography>

    {items.length === 0 ? (
      <Typography variant="body2" color="text.secondary">
        Уставки этого прибора ещё не правили: в журнале пусто.
      </Typography>
    ) : (
      <ol className={styles['audit__list']}>
        {items.map((entry) => (
          <li key={entry.id} className={styles['audit__item']}>
            <div className={styles['audit__head']}>
              <span className={styles['audit__what']}>
                {labels[entry.metricKey] ?? entry.metricKey}
                <span className={styles['audit__mode']}> · {MODE_LABEL[entry.mode]}</span>
              </span>
              <span className={styles['audit__who']}>
                {entry.changedBy} · {momentText(entry.changedAt)}
              </span>
            </div>

            {entry.created ? (
              <span className={styles['audit__field']}>уставка заведена</span>
            ) : (
              entry.fields.map((field) => (
                <span key={field.field} className={styles['audit__field']}>
                  {FIELD_LABEL[field.field] ?? field.field}: {valueText(field.before)} →{' '}
                  {valueText(field.after)}
                </span>
              ))
            )}
          </li>
        ))}
      </ol>
    )}
  </Paper>
);
