import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import type { AlarmStateFilter, Severity } from '@fieldstream/contracts';
import styles from './AlarmFilters.module.scss';

export interface FeedFilters {
  readonly state: AlarmStateFilter;
  readonly severity: Severity | 'all';
  readonly device: string;
}

interface Props {
  readonly value: FeedFilters;
  readonly devices: readonly string[];
  readonly onChange: (next: Partial<FeedFilters>) => void;
}

const STATE_LABEL: Readonly<Record<AlarmStateFilter, string>> = {
  any: 'все',
  active: 'незакрытые',
  cleared: 'снятые',
};

const SEVERITY_LABEL: Readonly<Record<Severity | 'all', string>> = {
  all: 'любая важность',
  info: 'сообщение',
  warning: 'предупреждение',
  critical: 'критическая',
};

/** Фильтры ленты живут в адресе страницы, поэтому отфильтрованную ленту можно переслать ссылкой. */
export const AlarmFilters = ({ value, devices, onChange }: Props): React.JSX.Element => (
  <div className={styles['filters']}>
    <ToggleButtonGroup
      size="small"
      exclusive
      value={value.state}
      onChange={(_event, next: AlarmStateFilter | null) => {
        if (next !== null) onChange({ state: next });
      }}
      aria-label="Состояние эпизодов"
    >
      {(['any', 'active', 'cleared'] as const).map((state) => (
        <ToggleButton key={state} value={state}>
          {STATE_LABEL[state]}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>

    <div className={styles['filters__field']}>
      <TextField
        size="small"
        select
        fullWidth
        label="Важность"
        value={value.severity}
        onChange={(event) => {
          onChange({ severity: event.target.value as Severity | 'all' });
        }}
      >
        {Object.entries(SEVERITY_LABEL).map(([key, label]) => (
          <MenuItem key={key} value={key}>
            {label}
          </MenuItem>
        ))}
      </TextField>
    </div>

    <div className={styles['filters__field']}>
      <TextField
        size="small"
        select
        fullWidth
        label="Прибор"
        value={value.device}
        onChange={(event) => {
          onChange({ device: event.target.value });
        }}
      >
        <MenuItem value="">все приборы</MenuItem>
        {devices.map((code) => (
          <MenuItem key={code} value={code}>
            {code}
          </MenuItem>
        ))}
      </TextField>
    </div>

    <Button
      size="small"
      disabled={value.state === 'any' && value.severity === 'all' && value.device === ''}
      onClick={() => {
        onChange({ state: 'any', severity: 'all', device: '' });
      }}
    >
      Сбросить
    </Button>
  </div>
);
