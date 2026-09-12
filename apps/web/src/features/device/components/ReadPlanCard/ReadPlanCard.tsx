import { useState } from 'react';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { useQuery } from '@tanstack/react-query';
import type { PlanMode, RegisterType } from '@fieldstream/contracts';
import { api } from '../../../../shared/api/endpoints.js';
import { queryKeys } from '../../../../shared/api/query-keys.js';
import { ErrorState } from '../../../../shared/ui/ErrorState/ErrorState.js';
import { SkeletonBlock } from '../../../../shared/ui/SkeletonBlock/SkeletonBlock.js';
import { counted } from '../../../../shared/text/plural.js';
import styles from './ReadPlanCard.module.scss';

interface Props {
  readonly code: string;
  readonly labels: Readonly<Record<string, string>>;
}

/** Тип регистра словами: holding пишется, input только читается, и это разные вещи. */
const REGISTER_LABEL: Readonly<Record<RegisterType, string>> = {
  holding: 'holding (запись)',
  input: 'input (чтение)',
};

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  declared: 'объявлен в профиле',
  merged: 'склеен автоматически',
  naive: 'по одному параметру',
};

/**
 * Карта регистров прибора. Показываются оба плана сразу: выигрыш склейки это разница между
 * ними, и без второго числа «четыре запроса» ни о чём не говорит. План тот же самый, что
 * уходит на линию, потому что считает его та же функция, что и сборщик.
 */
export const ReadPlanCard = ({ code, labels }: Props): React.JSX.Element => {
  const [mode, setMode] = useState<PlanMode>('merged');

  const merged = useQuery({
    queryKey: queryKeys.readPlan(code, 'merged'),
    queryFn: () => api.readPlan(code, 'merged'),
    staleTime: Infinity,
  });
  const naive = useQuery({
    queryKey: queryKeys.readPlan(code, 'naive'),
    queryFn: () => api.readPlan(code, 'naive'),
    staleTime: Infinity,
  });

  const shown = mode === 'merged' ? merged.data : naive.data;
  const saved =
    merged.data === undefined || naive.data === undefined
      ? null
      : naive.data.requests - merged.data.requests;

  return (
    <Paper variant="outlined" className={styles['plan']}>
      <div className={styles['plan__head']}>
        <Typography variant="subtitle2">Карта регистров</Typography>

        <ToggleButtonGroup
          size="small"
          exclusive
          value={mode}
          onChange={(_event, value: PlanMode | null) => {
            if (value !== null) setMode(value);
          }}
          aria-label="Вид плана чтения"
        >
          <ToggleButton value="merged">со склейкой</ToggleButton>
          <ToggleButton value="naive">по одному</ToggleButton>
        </ToggleButtonGroup>
      </div>

      {merged.isPending || naive.isPending ? (
        <SkeletonBlock rows={4} height={40} label="Считаем план чтения" />
      ) : null}

      {merged.isError || naive.isError ? (
        <ErrorState
          error={merged.error ?? naive.error}
          onRetry={() => {
            void merged.refetch();
            void naive.refetch();
          }}
        />
      ) : null}

      {shown === undefined ? null : (
        <>
          <div className={styles['plan__facts']}>
            <Chip size="small" label={`запросов: ${String(shown.requests)}`} />
            <Chip size="small" variant="outlined" label={`регистров: ${String(shown.registers)}`} />
            {saved === null || saved <= 0 ? null : (
              <Chip
                size="small"
                color="success"
                label={`склейка экономит ${counted(saved, ['запрос', 'запроса', 'запросов'])} из ${String(naive.data?.requests ?? 0)}`}
              />
            )}
          </div>

          <div className={styles['plan__scroll']}>
            <div className={styles['plan__grid']}>
              <div className={styles['plan__row_head']}>
                <span>Блок</span>
                <span>Регистры</span>
                <span>Адреса</span>
                <span>Параметры</span>
                <span>Откуда</span>
              </div>

              {shown.blocks.map((block) => (
                <div key={block.id} className={styles['plan__row']}>
                  <span className={styles['plan__id']}>{block.id}</span>
                  <span>{REGISTER_LABEL[block.registerType]}</span>
                  <span className={styles['plan__address']}>
                    {block.startAddress}…{block.startAddress + block.registerCount - 1}
                    <span className={styles['plan__count']}> ({block.registerCount})</span>
                  </span>
                  <span className={styles['plan__params']}>
                    {block.paramKeys.map((key) => labels[key] ?? key).join(', ')}
                  </span>
                  <span className={styles['plan__source']}>
                    {SOURCE_LABEL[block.source] ?? block.source}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </Paper>
  );
};
