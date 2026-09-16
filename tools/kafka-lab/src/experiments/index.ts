import { commits } from './commits.js';
import { compaction } from './compaction.js';
import { dlq } from './dlq.js';
import { groups } from './groups.js';
import { idempotency } from './idempotency.js';
import { lag } from './lag.js';
import { order } from './order.js';
import { rebalance } from './rebalance.js';
import type { Experiment, ExperimentName } from '../experiment.js';

/** Реестр опытов: имя команды и опыт за ним. Запись обязательна для каждого имени из EXPERIMENT_NAMES. */
export const EXPERIMENTS: Readonly<Record<ExperimentName, Experiment>> = Object.freeze({
  order,
  groups,
  rebalance,
  commits,
  idempotency,
  dlq,
  lag,
  compaction,
});
