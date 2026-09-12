import { useReducer } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { alarmRuleUpdateSchema } from '@fieldstream/contracts';
import type { AlarmRuleUpdate, AlarmRuleView, Severity } from '@fieldstream/contracts';
import { MODE_LABEL } from '../../../device/mode-view.js';
import styles from './RulesTable.module.scss';

interface Props {
  readonly rules: readonly AlarmRuleView[];
  readonly labels: Readonly<Record<string, string>>;
  readonly editable: boolean;
  readonly saving: boolean;
  readonly onSave: (updates: readonly AlarmRuleUpdate[]) => void;
}

const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  info: 'сообщение',
  warning: 'предупреждение',
  critical: 'критическая',
};

const keyOf = (rule: { metricKey: string; mode: string }): string =>
  `${rule.metricKey}|${rule.mode}`;

const draftOf = (rule: AlarmRuleView): AlarmRuleUpdate => ({
  metricKey: rule.metricKey,
  mode: rule.mode,
  minValue: rule.minValue,
  maxValue: rule.maxValue,
  hysteresis: rule.hysteresis,
  debounceCycles: rule.debounceCycles,
  severity: rule.severity,
  enabled: rule.enabled,
});

type Drafts = Readonly<Record<string, AlarmRuleUpdate>>;

type Action =
  | {
      readonly kind: 'edit';
      readonly rule: AlarmRuleView;
      readonly patch: Partial<AlarmRuleUpdate>;
    }
  | { readonly kind: 'reset' };

const reduce = (state: Drafts, action: Action): Drafts => {
  if (action.kind === 'reset') return {};

  const key = keyOf(action.rule);
  const current = state[key] ?? draftOf(action.rule);

  return { ...state, [key]: { ...current, ...action.patch } };
};

/** Правка, которая ничего не меняет, правкой не считается: сервер её тоже отбросит. */
const touched = (drafts: Drafts, rules: readonly AlarmRuleView[]): AlarmRuleUpdate[] => {
  const byKey = new Map(rules.map((rule) => [keyOf(rule), draftOf(rule)]));

  return Object.entries(drafts).flatMap(([key, draft]) => {
    const before = byKey.get(key);

    return before !== undefined && JSON.stringify(before) === JSON.stringify(draft) ? [] : [draft];
  });
};

const problemOf = (draft: AlarmRuleUpdate): string | null => {
  const parsed = alarmRuleUpdateSchema.safeParse(draft);

  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'значения не годятся');
};

const numberOrNull = (text: string): number | null => {
  if (text.trim().length === 0) return null;
  const value = Number(text);

  return Number.isFinite(value) ? value : null;
};

/**
 * Уставки по режимам. Проверяются той же схемой, что и на сервере, иначе экран разрешит то,
 * что шлюз отвергнет. Правка уезжает одним запросом со всеми тронутыми строками.
 */
export const RulesTable = ({
  rules,
  labels,
  editable,
  saving,
  onSave,
}: Props): React.JSX.Element => {
  const [drafts, dispatch] = useReducer(reduce, {});

  const pending = touched(drafts, rules);
  const problems = pending.flatMap((draft) => {
    const problem = problemOf(draft);

    return problem === null ? [] : [problem];
  });

  return (
    <Paper variant="outlined" className={styles['rules']}>
      <div className={styles['rules__head']}>
        <Typography variant="subtitle2">Уставки по режимам</Typography>

        {editable ? (
          <div className={styles['rules__actions']}>
            <Button
              size="small"
              disabled={pending.length === 0 || saving}
              onClick={() => {
                dispatch({ kind: 'reset' });
              }}
            >
              Отменить
            </Button>
            <Button
              size="small"
              variant="contained"
              disabled={pending.length === 0 || problems.length > 0 || saving}
              onClick={() => {
                onSave(pending);
              }}
            >
              Сохранить{pending.length === 0 ? '' : ` (${String(pending.length)})`}
            </Button>
          </div>
        ) : (
          <Typography variant="caption" color="text.secondary">
            правка уставок закрыта для вашей роли
          </Typography>
        )}
      </div>

      {problems.length === 0 ? null : (
        <Alert severity="warning" className={styles['rules__problem']}>
          {problems[0]}
        </Alert>
      )}

      <div className={styles['rules__scroll']}>
        <div className={styles['rules__grid']}>
          <div className={styles['rules__row_head']}>
            <span>Параметр</span>
            <span>Режим</span>
            <span>Нижняя</span>
            <span>Верхняя</span>
            <span>Гистерезис</span>
            <span>Такты</span>
            <span>Важность</span>
            <span>Включена</span>
          </div>

          {rules.map((rule) => {
            const draft = drafts[keyOf(rule)] ?? draftOf(rule);
            const edit = (patch: Partial<AlarmRuleUpdate>): void => {
              dispatch({ kind: 'edit', rule, patch });
            };

            return (
              <div key={keyOf(rule)} className={styles['rules__row']}>
                <span className={styles['rules__metric']}>
                  {labels[rule.metricKey] ?? rule.metricKey}
                </span>
                <span className={styles['rules__mode']}>{MODE_LABEL[rule.mode]}</span>

                <TextField
                  size="small"
                  type="number"
                  disabled={!editable}
                  value={draft.minValue ?? ''}
                  onChange={(event) => {
                    edit({ minValue: numberOrNull(event.target.value) });
                  }}
                  slotProps={{
                    htmlInput: { 'aria-label': `нижняя граница ${rule.metricKey} ${rule.mode}` },
                  }}
                />
                <TextField
                  size="small"
                  type="number"
                  disabled={!editable}
                  value={draft.maxValue ?? ''}
                  onChange={(event) => {
                    edit({ maxValue: numberOrNull(event.target.value) });
                  }}
                  slotProps={{
                    htmlInput: { 'aria-label': `верхняя граница ${rule.metricKey} ${rule.mode}` },
                  }}
                />
                <TextField
                  size="small"
                  type="number"
                  disabled={!editable}
                  value={draft.hysteresis}
                  onChange={(event) => {
                    edit({ hysteresis: numberOrNull(event.target.value) ?? 0 });
                  }}
                  slotProps={{
                    htmlInput: { 'aria-label': `гистерезис ${rule.metricKey} ${rule.mode}` },
                  }}
                />
                <TextField
                  size="small"
                  type="number"
                  disabled={!editable}
                  value={draft.debounceCycles}
                  onChange={(event) => {
                    edit({ debounceCycles: numberOrNull(event.target.value) ?? 1 });
                  }}
                  slotProps={{
                    htmlInput: { 'aria-label': `такты ${rule.metricKey} ${rule.mode}` },
                  }}
                />
                <TextField
                  size="small"
                  select
                  disabled={!editable}
                  value={draft.severity}
                  onChange={(event) => {
                    edit({ severity: event.target.value as Severity });
                  }}
                  slotProps={{
                    htmlInput: { 'aria-label': `важность ${rule.metricKey} ${rule.mode}` },
                  }}
                >
                  {Object.entries(SEVERITY_LABEL).map(([value, label]) => (
                    <MenuItem key={value} value={value}>
                      {label}
                    </MenuItem>
                  ))}
                </TextField>
                <Switch
                  size="small"
                  disabled={!editable}
                  checked={draft.enabled}
                  onChange={(event) => {
                    edit({ enabled: event.target.checked });
                  }}
                  slotProps={{
                    input: { 'aria-label': `уставка включена ${rule.metricKey} ${rule.mode}` },
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </Paper>
  );
};
