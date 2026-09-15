import { useId, useState } from 'react';
import Alert from '@mui/material/Alert';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { ReplayChangedRule, ReplayRun } from '@fieldstream/contracts';
import { counted } from '../../../../../shared/text/plural.js';
import { spanText } from '../../../../../shared/time/human-time.js';
import { EmptyState } from '../../../../../shared/ui/EmptyState/EmptyState.js';
import { ErrorState } from '../../../../../shared/ui/ErrorState/ErrorState.js';
import { SkeletonBlock } from '../../../../../shared/ui/SkeletonBlock/SkeletonBlock.js';
import { MODE_LABEL } from '../../../../device/mode-view.js';
import { useReplayDiff } from '../../../hooks/result/useReplayDiff.js';
import { useMetricParams } from '../../../hooks/useMetricParams.js';
import {
  DEVICE_FORMS,
  clockText,
  coverageGap,
  isEmptyWindow,
  ruleChangeText,
} from '../../../replay-words.js';
import { ReplayDiffTable, rowKeyOf } from '../ReplayDiffTable/ReplayDiffTable.js';
import { ReplayRowChart } from '../ReplayRowChart/ReplayRowChart.js';
import styles from './ReplayResult.module.scss';

interface Props {
  readonly run: ReplayRun;
  readonly retentionMs: number;
}

interface ChangeGroup {
  readonly key: string;
  readonly text: string;
  readonly devices: number;
}

/** Изменённые уставки одной строкой на параметр, режим и суть изменения. */
const changeGroups = (
  rules: readonly ReplayChangedRule[],
  labelOf: (metricKey: string) => string,
): ChangeGroup[] => {
  const groups = new Map<string, { text: string; devices: number }>();
  for (const rule of rules) {
    const text = `${labelOf(rule.metricKey)}, ${MODE_LABEL[rule.mode]}: ${ruleChangeText(rule)}`;
    const current = groups.get(text);
    groups.set(text, { text, devices: (current?.devices ?? 0) + 1 });
  }

  return [...groups.entries()].map(([key, group]) => ({ key, ...group }));
};

/** Оговорка о покрытии: кадры начинаются позже начала окна или кончаются раньше конца. */
const coverageText = (run: ReplayRun): string | null => {
  const gap = coverageGap(run);
  if ((!gap.late && !gap.early) || run.coveredFrom === null || run.coveredTo === null) return null;
  const span = `с ${clockText(run.coveredFrom)} по ${clockText(run.coveredTo)}`;
  if (gap.late && gap.early) {
    return `Кадры есть не на всё окно: покрытие ${span}. За остальное время брокер кадров не хранит или стенд не работал.`;
  }
  if (gap.late) {
    return `Кадры есть не с начала окна: покрытие ${span}. Раньше брокер кадров не хранит или стенд не работал.`;
  }

  return `Кадры кончаются раньше конца окна: покрытие ${span}.`;
};

/**
 * Итог завершённого перепрогона: что правка изменила в уставках и в срабатываниях. Колонка
 * «Вживую» справочная: живой поток мог стоять, а уставки могли меняться посреди окна.
 */
export const ReplayResult = ({ run, retentionMs }: Props): React.JSX.Element => {
  const titleId = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const { labelOf, paramOf } = useMetricParams(run.deviceCodes);
  const emptyWindow = isEmptyWindow(run);
  const noFrames = !emptyWindow && run.coveredFrom === null;
  const diff = useReplayDiff(run, !emptyWindow && !noFrames);
  const rows = diff.diff?.rows ?? [];
  const changed = diff.diff?.changedRules ?? [];
  const selected = rows.find((row) => rowKeyOf(row) === picked) ?? rows[0];
  const unchanged = rows.every((row) => row.added === 0 && row.removed === 0);
  const coverage = coverageText(run);

  return (
    <Paper
      variant="outlined"
      component="section"
      aria-labelledby={titleId}
      className={styles['result']}
    >
      <Typography variant="subtitle1" component="h2" id={titleId}>
        Разница срабатываний
      </Typography>

      {emptyWindow ? (
        <EmptyState
          title="В окне нет кадров"
          hint={`Брокер не хранит сырых кадров за это окно. Засеянная история лежит только в базе: перепрогнать можно кадры, которые стенд собрал сам за последние ${spanText(retentionMs)}.`}
        />
      ) : null}

      {noFrames ? (
        <EmptyState
          title="Кадров выбранных приборов в окне нет"
          hint="Сырые кадры за окно в брокере есть, но ни один не пришёл от выбранных приборов: их опрос мог быть выключен."
        />
      ) : null}

      {diff.isPending ? <SkeletonBlock rows={3} height={44} label="Считаем разницу" /> : null}

      {diff.isError ? <ErrorState error={diff.error} onRetry={diff.refetch} /> : null}

      {diff.diff === undefined ? null : (
        <>
          {coverage === null ? null : (
            <Alert severity="info" role="note" className={styles['result__notice']}>
              {coverage}
            </Alert>
          )}

          {changed.length === 0 ? null : (
            <div className={styles['result__changes']}>
              <Typography variant="body2" component="h3" className={styles['result__subtitle']}>
                Правка изменила уставки
              </Typography>
              <ul className={styles['result__list']}>
                {changeGroups(changed, labelOf).map((group) => (
                  <li key={group.key}>
                    {`${group.text} · ${counted(group.devices, DEVICE_FORMS)}`}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {rows.length === 0 ? (
            <EmptyState
              title="Правка не изменила ни одного срабатывания"
              hint="Ни прежние, ни новые уставки не дали в окне ни одного эпизода."
            />
          ) : (
            <>
              {unchanged ? (
                <Alert severity="info" role="note" className={styles['result__notice']}>
                  Правка не изменила ни одного срабатывания: эпизоды обоих вариантов совпали.
                </Alert>
              ) : null}

              <ReplayDiffTable
                rows={rows}
                selectedKey={selected === undefined ? null : rowKeyOf(selected)}
                labelOf={labelOf}
                onSelect={setPicked}
              />

              <Typography variant="caption" className={styles['result__caption']}>
                Было и стало посчитаны по одним и тем же сырым кадрам с чистого состояния. Вживую
                это эпизоды из журнала алармов за то же покрытие, для справки: живой поток мог
                стоять, а уставки могли меняться посреди окна.
              </Typography>

              {selected === undefined ? null : (
                <ReplayRowChart
                  key={rowKeyOf(selected)}
                  run={run}
                  row={selected}
                  param={paramOf(selected.metricKey)}
                  changedRule={changed.find(
                    (rule) =>
                      rule.deviceCode === selected.deviceCode &&
                      rule.metricKey === selected.metricKey &&
                      rule.mode === selected.mode,
                  )}
                />
              )}
            </>
          )}
        </>
      )}
    </Paper>
  );
};
