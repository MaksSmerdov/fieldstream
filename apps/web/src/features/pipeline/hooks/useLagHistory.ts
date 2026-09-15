import { useEffect, useReducer } from 'react';
import type { PipelineResponse } from '@fieldstream/contracts';
import { EMPTY_LAG_HISTORY, appendLagSample } from '../pipeline-geometry.js';
import type { LagHistory, LagSample } from '../pipeline-geometry.js';

/** Редьюсер истории с пределами по умолчанию. */
const reduceHistory = (history: LagHistory, sample: LagSample): LagHistory =>
  appendLagSample(history, sample);

/** История суммарного отставания групп, накопленная между опросами. */
export const useLagHistory = (data: PipelineResponse | undefined): LagHistory => {
  const [history, append] = useReducer(reduceHistory, EMPTY_LAG_HISTORY);
  const sampledAt = data?.sampledAt ?? null;
  const groups = data?.groups;

  useEffect(() => {
    if (sampledAt === null || groups === undefined) return;
    append({ sampledAt, groups });
  }, [sampledAt, groups]);

  return history;
};
