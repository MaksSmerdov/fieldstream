import { useEffect, useReducer, useRef } from 'react';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScenarioRun } from '@fieldstream/contracts';
import { api } from '../../../../shared/api/endpoints.js';
import { ApiError } from '../../../../shared/api/http.js';
import { queryKeys } from '../../../../shared/api/query-keys.js';
import { isRunFinished } from '../../scenario-words.js';

export const RUN_POLL_MS = 1_000;

/** Ошибка опроса хода, которую повтор не исправит: прогона нет, нет права или ответ не по контракту. */
export const isFatalRunError = (error: unknown): boolean => {
  if (error === null || error === undefined) return false;
  if (!(error instanceof ApiError)) return true;

  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
};

/** Шлюз отказал в запуске, потому что стенд занят другим прогоном. */
const isBusyRejection = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409;

interface WatchState {
  readonly runId: string | null;
  readonly dismissed: boolean;
}

type WatchEvent =
  { readonly type: 'follow'; readonly runId: string } | { readonly type: 'dismiss' };

const INITIAL_WATCH: WatchState = { runId: null, dismissed: false };

/** Какой прогон на панели хода: новый прогон сменяет прежний и снова виден. */
const watchReducer = (state: WatchState, event: WatchEvent): WatchState => {
  if (event.type === 'dismiss') return state.dismissed ? state : { ...state, dismissed: true };

  return state.runId === event.runId ? state : { runId: event.runId, dismissed: false };
};

/** Прогон, который сейчас занимает стенд: свежий ход важнее списка, опрашиваемого реже. */
const activeOf = (
  run: ScenarioRun | null,
  listed: ScenarioRun | null,
  stopped: boolean,
): ScenarioRun | null => {
  if (run === null || stopped) return listed;
  if (!isRunFinished(run)) return run;

  return listed !== null && listed.id !== run.id ? listed : null;
};

export interface LaunchFailure {
  readonly name: string;
  readonly error: unknown;
}

export interface ScenarioRunWatch {
  readonly run: ScenarioRun | null;
  readonly activeRun: ScenarioRun | null;
  readonly pollError: unknown;
  readonly stopped: boolean;
  readonly launching: string | null;
  readonly launchFailure: LaunchFailure | null;
  readonly launch: (name: string) => void;
  readonly dismissRun: () => void;
  readonly dismissFailure: () => void;
}

/**
 * Запуск сценария и ход прогона. Прогон берётся из ответа на запуск или из списка, если его
 * запустили в другом месте; ход опрашивается раз в секунду до итога, после итога
 * перечитывается список.
 */
export const useScenarioRun = (listed: ScenarioRun | null): ScenarioRunWatch => {
  const client = useQueryClient();
  const [watch, dispatch] = useReducer(watchReducer, INITIAL_WATCH);
  const listedId = listed?.id ?? null;
  const { runId } = watch;

  useEffect(() => {
    if (listedId !== null) dispatch({ type: 'follow', runId: listedId });
  }, [listedId]);

  const mutation = useMutation({
    mutationFn: (name: string) => api.runScenario(name),
    onSuccess: async (accepted) => {
      client.setQueryData(queryKeys.scenarioRun(accepted.id), accepted);
      dispatch({ type: 'follow', runId: accepted.id });
      await client.invalidateQueries({ queryKey: queryKeys.scenarios });
    },
    onError: async (error) => {
      if (isBusyRejection(error)) {
        await client.invalidateQueries({ queryKey: queryKeys.scenarios });
      }
    },
  });

  const progress = useQuery({
    queryKey: queryKeys.scenarioRun(runId ?? ''),
    queryFn: runId === null ? skipToken : () => api.scenarioRun(runId),
    staleTime: RUN_POLL_MS,
    retry: false,
    refetchInterval: (query) => {
      const { data, error } = query.state;
      if (data !== undefined && isRunFinished(data)) return false;

      return isFatalRunError(error) ? false : RUN_POLL_MS;
    },
  });

  const fallback = listed !== null && listed.id === runId ? listed : null;
  const run = runId === null ? null : (progress.data ?? fallback);
  const finishedId = run !== null && isRunFinished(run) ? run.id : null;
  const stopped = run !== null && finishedId === null && isFatalRunError(progress.error);
  const activeRun = activeOf(run, listed, stopped);
  const activeId = activeRun?.id ?? null;
  const busyRejected = mutation.isError && isBusyRejection(mutation.error);
  const { reset } = mutation;
  const busySeen = useRef(false);

  useEffect(() => {
    if (!busyRejected) {
      busySeen.current = false;
      return;
    }
    if (activeId !== null) {
      busySeen.current = true;
      return;
    }
    if (busySeen.current) {
      busySeen.current = false;
      reset();
    }
  }, [activeId, busyRejected, reset]);

  useEffect(() => {
    if (finishedId === null) return;

    void client.invalidateQueries({ queryKey: queryKeys.scenarios });
  }, [client, finishedId]);

  return {
    run: watch.dismissed ? null : run,
    activeRun,
    pollError: progress.error,
    stopped,
    launching: mutation.isPending ? mutation.variables : null,
    launchFailure: mutation.isError ? { name: mutation.variables, error: mutation.error } : null,
    launch: (name: string) => {
      mutation.mutate(name);
    },
    dismissRun: () => {
      dispatch({ type: 'dismiss' });
    },
    dismissFailure: () => {
      mutation.reset();
    },
  };
};
