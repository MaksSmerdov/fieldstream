import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { DeviceProfileView, DeviceSnapshot, ProfileParamView } from '@fieldstream/contracts';
import { ValueCell } from '../../../../shared/ui/ValueCell/ValueCell.js';
import { stateWords } from '../../state-words.js';
import styles from './DeviceValues.module.scss';

interface Props {
  readonly profile: DeviceProfileView;
  readonly snapshot: DeviceSnapshot;
}

/** Разряды слова аварий: показываются только поднятые, иначе список из шестнадцати нулей. */
const bitsOf = (param: ProfileParamView, value: number | null): string[] => {
  if (value === null || param.bits === null) return [];

  return param.bits.filter((bit) => (value & (1 << bit.bit)) !== 0).map((bit) => bit.label);
};

/**
 * Значения прибора по секциям профиля. Порядок и группировка те же, что в документации на
 * прибор: инженер ищет параметр там, где привык, а не в общем алфавитном списке.
 */
export const DeviceValues = ({ profile, snapshot }: Props): React.JSX.Element => {
  const byKey = new Map(snapshot.metrics.map((metric) => [metric.metricKey, metric]));

  return (
    <div className={styles['values']}>
      {profile.sections.map((section) => (
        <Paper key={section.key} variant="outlined" className={styles['values__section']}>
          <Typography variant="subtitle2" className={styles['values__title']}>
            {section.label}
          </Typography>

          {section.params.map((param) => {
            const metric = byKey.get(param.metricKey);
            const raised = param.kind === 'bits' ? bitsOf(param, metric?.value ?? null) : [];

            return (
              <div key={param.metricKey} className={styles['values__row']}>
                <span className={styles['values__label']}>{param.label}</span>

                {param.kind === 'bits' ? (
                  <span className={styles['values__bits']}>
                    {snapshot.stale || metric?.value == null ? (
                      <ValueCell value={null} stale={snapshot.stale} />
                    ) : raised.length === 0 ? (
                      <span className={styles['values__quiet']}>аварий нет</span>
                    ) : (
                      raised.map((label) => (
                        <Chip key={label} size="small" color="error" label={label} />
                      ))
                    )}
                  </span>
                ) : (
                  <ValueCell
                    value={metric?.value ?? null}
                    unit={param.unit}
                    precision={param.precision}
                    quality={metric?.quality ?? 'bad'}
                    stale={snapshot.stale}
                    states={stateWords(param.states)}
                  />
                )}
              </div>
            );
          })}
        </Paper>
      ))}
    </div>
  );
};
