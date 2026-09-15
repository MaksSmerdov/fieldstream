import { useId } from 'react';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { DeviceMode, ReplayPatchField } from '@fieldstream/contracts';
import { MODE_LABEL } from '../../../../device/mode-view.js';
import { currentHint } from '../../../replay-form.js';
import type { EnabledChoice, PatchDraft, PatchEdit, RuleCatalog } from '../../../replay-form.js';
import styles from './PatchEditor.module.scss';

interface Props {
  readonly draft: PatchDraft;
  readonly index: number;
  readonly codes: readonly string[];
  readonly options: ReadonlyMap<string, readonly DeviceMode[]>;
  readonly rules: RuleCatalog;
  readonly labelOf: (metricKey: string) => string;
  readonly disabled: boolean;
  readonly removable: boolean;
  readonly onEdit: (edit: PatchEdit) => void;
  readonly onRemove: () => void;
}

const ENABLED_LABEL: Readonly<Record<EnabledChoice, string>> = {
  keep: 'как было',
  on: 'включить',
  off: 'выключить',
};

interface BoundSpec {
  readonly field: 'minValue' | 'maxValue';
  readonly clearKey: 'clearMin' | 'clearMax';
  readonly label: string;
  readonly clearLabel: string;
}

const BOUNDS: readonly BoundSpec[] = [
  {
    field: 'minValue',
    clearKey: 'clearMin',
    label: 'Нижняя граница',
    clearLabel: 'Снять нижнюю границу',
  },
  {
    field: 'maxValue',
    clearKey: 'clearMax',
    label: 'Верхняя граница',
    clearLabel: 'Снять верхнюю границу',
  },
];

/**
 * Одна правка уставки. Пустое поле оставляет значение как было, снятие границы это отдельное
 * действие: иначе очищенное поле нельзя было бы отличить от «не трогать».
 */
export const PatchEditor = ({
  draft,
  index,
  codes,
  options,
  rules,
  labelOf,
  disabled,
  removable,
  onEdit,
  onRemove,
}: Props): React.JSX.Element => {
  const titleId = useId();
  const metricKeys = [...options.keys()];
  if (draft.metricKey !== '' && !options.has(draft.metricKey)) metricKeys.push(draft.metricKey);
  const modes = [...(options.get(draft.metricKey) ?? [])];
  if (!modes.includes(draft.mode)) modes.push(draft.mode);
  const keyChosen = draft.metricKey !== '';
  const hint = (field: ReplayPatchField): string => currentHint(rules, codes, draft, field);

  return (
    <div role="group" aria-labelledby={titleId} className={styles['patch']}>
      <div className={styles['patch__head']}>
        <Typography variant="subtitle2" component="h4" id={titleId}>
          {`Правка ${String(index + 1)}`}
        </Typography>

        {removable ? (
          <Button size="small" color="inherit" disabled={disabled} onClick={onRemove}>
            Убрать правку
          </Button>
        ) : null}
      </div>

      <div className={styles['patch__key']}>
        <TextField
          size="small"
          select
          fullWidth
          label="Параметр"
          value={draft.metricKey}
          disabled={disabled || metricKeys.length === 0}
          helperText={codes.length === 0 ? 'сначала выберите приборы' : ' '}
          onChange={(event) => {
            const metricKey = event.target.value;
            const available = options.get(metricKey) ?? [];
            onEdit({
              metricKey,
              mode: available.includes(draft.mode) ? draft.mode : (available[0] ?? draft.mode),
            });
          }}
        >
          {metricKeys.map((metricKey) => (
            <MenuItem key={metricKey} value={metricKey}>
              {labelOf(metricKey)}
            </MenuItem>
          ))}
        </TextField>

        <TextField
          size="small"
          select
          fullWidth
          label="Режим"
          value={draft.mode}
          disabled={disabled || !keyChosen}
          helperText=" "
          onChange={(event) => {
            onEdit({ mode: event.target.value as DeviceMode });
          }}
        >
          {modes.map((mode) => (
            <MenuItem key={mode} value={mode}>
              {MODE_LABEL[mode]}
            </MenuItem>
          ))}
        </TextField>
      </div>

      <div className={styles['patch__fields']}>
        {BOUNDS.map((bound) => {
          const cleared = draft[bound.clearKey];

          return (
            <div key={bound.field} className={styles['patch__bound']}>
              <TextField
                size="small"
                type="number"
                fullWidth
                label={bound.label}
                value={cleared ? '' : draft[bound.field]}
                disabled={disabled || !keyChosen || cleared}
                placeholder={cleared ? 'будет снята' : 'как было'}
                helperText={cleared ? 'граница будет снята' : hint(bound.field) || ' '}
                onChange={(event) => {
                  const text = event.target.value;
                  onEdit(bound.field === 'minValue' ? { minValue: text } : { maxValue: text });
                }}
                slotProps={{ inputLabel: { shrink: true }, htmlInput: { step: 'any' } }}
              />
              <Button
                size="small"
                variant={cleared ? 'contained' : 'text'}
                disabled={disabled || !keyChosen}
                aria-pressed={cleared}
                className={styles['patch__clear']}
                onClick={() => {
                  onEdit(
                    bound.clearKey === 'clearMin' ? { clearMin: !cleared } : { clearMax: !cleared },
                  );
                }}
              >
                {bound.clearLabel}
              </Button>
            </div>
          );
        })}

        <TextField
          size="small"
          type="number"
          fullWidth
          label="Гистерезис"
          value={draft.hysteresis}
          disabled={disabled || !keyChosen}
          placeholder="как было"
          helperText={hint('hysteresis') || ' '}
          onChange={(event) => {
            onEdit({ hysteresis: event.target.value });
          }}
          slotProps={{ inputLabel: { shrink: true }, htmlInput: { step: 'any', min: 0 } }}
        />

        <TextField
          size="small"
          type="number"
          fullWidth
          label="Выдержка, циклов"
          value={draft.debounceCycles}
          disabled={disabled || !keyChosen}
          placeholder="как было"
          helperText={hint('debounceCycles') || ' '}
          onChange={(event) => {
            onEdit({ debounceCycles: event.target.value });
          }}
          slotProps={{ inputLabel: { shrink: true }, htmlInput: { step: 1, min: 1, max: 60 } }}
        />

        <TextField
          size="small"
          select
          fullWidth
          label="Уставка"
          value={draft.enabled}
          disabled={disabled || !keyChosen}
          helperText={hint('enabled') || ' '}
          onChange={(event) => {
            onEdit({ enabled: event.target.value as EnabledChoice });
          }}
        >
          {(Object.keys(ENABLED_LABEL) as EnabledChoice[]).map((choice) => (
            <MenuItem key={choice} value={choice}>
              {ENABLED_LABEL[choice]}
            </MenuItem>
          ))}
        </TextField>
      </div>
    </div>
  );
};
