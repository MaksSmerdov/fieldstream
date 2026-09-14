import { useMemo, useReducer } from 'react';
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import type {
  LabFaultsResponse,
  SimFault,
  SimFaultKind,
  SimTargetKind,
} from '@fieldstream/contracts';
import { api } from '../../../../shared/api/endpoints.js';
import { queryKeys } from '../../../../shared/api/query-keys.js';
import { ALL_FAULTS_KEY, faultKey } from '../../fault-kinds.js';

export const FAULT_TTL_SEC = 300;

const MUTATION_KEY = ['lab', 'fault-change'] as const;

export type FaultChange =
  | {
      readonly action: 'inject';
      readonly targetKind: SimTargetKind;
      readonly targetId: string;
      readonly kind: SimFaultKind;
    }
  | { readonly action: 'clear'; readonly targetId: string; readonly kind: SimFaultKind }
  | { readonly action: 'clearAll' };

/** Ключ действия: какую поломку или весь стенд оно трогает. */
export const changeKey = (change: FaultChange): string =>
  change.action === 'clearAll' ? ALL_FAULTS_KEY : faultKey(change.targetId, change.kind);

/** Поломки после удачного действия, до перечитывания с сервера. */
const faultsAfter = (
  faults: readonly SimFault[],
  change: FaultChange,
  created: SimFault | null,
): SimFault[] => {
  if (change.action === 'clearAll') return [];

  const rest = faults.filter(
    (fault) => !(fault.targetId === change.targetId && fault.kind === change.kind),
  );

  return created === null ? rest : [...rest, created];
};

export interface FaultFailure {
  readonly key: string;
  readonly change: FaultChange;
  readonly error: unknown;
}

interface OutcomeState {
  readonly failures: readonly FaultFailure[];
  readonly done: FaultChange | null;
}

type OutcomeEvent =
  | { readonly type: 'start'; readonly change: FaultChange }
  | { readonly type: 'succeed'; readonly change: FaultChange }
  | { readonly type: 'fail'; readonly change: FaultChange; readonly error: unknown }
  | { readonly type: 'dismiss'; readonly key: string };

const INITIAL_OUTCOME: OutcomeState = { failures: [], done: null };

/** Итоги действий: отказ хранится по ключу действия, пока его не закроют или не повторят. */
const outcomeReducer = (state: OutcomeState, event: OutcomeEvent): OutcomeState => {
  if (event.type === 'dismiss') {
    return { ...state, failures: state.failures.filter((item) => item.key !== event.key) };
  }

  const key = changeKey(event.change);
  const failures = state.failures.filter((item) => item.key !== key);

  if (event.type === 'start') return { ...state, failures };
  if (event.type === 'succeed') return { failures, done: event.change };

  return { ...state, failures: [...failures, { key, change: event.change, error: event.error }] };
};

export interface FaultActions {
  readonly change: (change: FaultChange) => void;
  readonly pendingKeys: ReadonlySet<string>;
  readonly failures: readonly FaultFailure[];
  readonly done: FaultChange | null;
  readonly dismiss: (key: string) => void;
}

/** Внесение и снятие поломок; после успеха перечитывает действующие поломки. */
export const useFaultActions = (): FaultActions => {
  const client = useQueryClient();
  const [outcome, dispatch] = useReducer(outcomeReducer, INITIAL_OUTCOME);

  const mutation = useMutation({
    mutationKey: MUTATION_KEY,
    mutationFn: async (change: FaultChange): Promise<SimFault | null> => {
      if (change.action === 'inject') {
        return api.injectFault({
          targetKind: change.targetKind,
          targetId: change.targetId,
          kind: change.kind,
          ttlSec: FAULT_TTL_SEC,
        });
      }

      await api.clearFaults(
        change.action === 'clear' ? { targetId: change.targetId, kind: change.kind } : {},
      );

      return null;
    },
    onSuccess: async (created, change) => {
      dispatch({ type: 'succeed', change });
      client.setQueryData<LabFaultsResponse>(queryKeys.labFaults, (current) =>
        current === undefined
          ? current
          : { ...current, faults: faultsAfter(current.faults, change, created) },
      );
      await client.invalidateQueries({ queryKey: queryKeys.labFaults });
    },
    onError: (error, change) => {
      dispatch({ type: 'fail', change, error });
    },
  });

  const pending = useMutationState<FaultChange | undefined>({
    filters: { mutationKey: MUTATION_KEY, status: 'pending' },
    select: (entry) => entry.state.variables as FaultChange | undefined,
  });

  const pendingKeys = useMemo(
    () => new Set(pending.flatMap((change) => (change === undefined ? [] : [changeKey(change)]))),
    [pending],
  );

  return {
    change: (change: FaultChange) => {
      dispatch({ type: 'start', change });
      mutation.mutate(change);
    },
    pendingKeys,
    failures: outcome.failures,
    done: outcome.done,
    dismiss: (key: string) => {
      dispatch({ type: 'dismiss', key });
    },
  };
};
