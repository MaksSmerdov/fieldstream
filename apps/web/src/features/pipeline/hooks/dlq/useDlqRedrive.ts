import { useEffect, useState } from 'react';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DlqRedrive } from '@fieldstream/contracts';
import { api } from '../../../../shared/api/endpoints.js';
import { ApiError } from '../../../../shared/api/http.js';
import { queryKeys } from '../../../../shared/api/query-keys.js';

export const REDRIVE_POLL_MS = 1_000;
export const REDRIVE_WAIT_LIMIT_MS = 60_000;

/** Почему ход запроса больше не опрашивается, хотя итога нет. */
export type RedriveWatchStop = 'unreadable' | 'timeout';

/** Запрос завершён, и спрашивать о нём больше нечего. */
export const isRedriveFinished = (redrive: DlqRedrive | undefined): boolean =>
  redrive?.status === 'done' || redrive?.status === 'failed';

/** Ошибка опроса, которую повтор не исправит: запроса нет, нет права или ответ не по контракту. */
export const isFatalProgressError = (error: unknown): boolean => {
  if (error === null || error === undefined) return false;
  if (!(error instanceof ApiError)) return true;

  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
};

/** Шаг хода: предел ожидания отсчитывается заново при каждой смене состояния. */
const stepOf = (redrive: DlqRedrive): string => `${redrive.id}|${redrive.status}`;

/** Причина остановки опроса у незавершённого шага. */
const stopOf = (
  step: string | null,
  error: unknown,
  expiredStep: string | null,
): RedriveWatchStop | null => {
  if (step === null) return null;
  if (isFatalProgressError(error)) return 'unreadable';

  return step === expiredStep ? 'timeout' : null;
};

export interface DlqRedriveControl {
  readonly start: (max: number) => void;
  readonly sending: boolean;
  readonly sendError: unknown;
  readonly redrive: DlqRedrive | null;
  readonly progressError: unknown;
  readonly stop: RedriveWatchStop | null;
  /** Запрос отправляется или ещё идёт: второй запрос в это время не нужен. */
  readonly busy: boolean;
}

/**
 * Повторная подача из очереди недоставленных. Шлюз только принимает запрос, выполняет его
 * процессор, поэтому ход читается опросом раз в секунду до итога, неустранимой ошибки или
 * предела ожидания, а после итога перечитывается снимок конвейера. Список очереди перечитает
 * себя сам по новым счётам, не сбивая идущую подгрузку страницы.
 */
export const useDlqRedrive = (): DlqRedriveControl => {
  const client = useQueryClient();
  const [requestId, setRequestId] = useState<string | null>(null);
  const [expiredStep, setExpiredStep] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (max: number) => api.redriveDlq(max),
    onMutate: () => {
      setRequestId(null);
      setExpiredStep(null);
    },
    onSuccess: (accepted) => {
      client.setQueryData(queryKeys.dlqRedrive(accepted.id), accepted);
      setRequestId(accepted.id);
    },
  });

  const progress = useQuery({
    queryKey: queryKeys.dlqRedrive(requestId ?? ''),
    queryFn: requestId === null ? skipToken : () => api.dlqRedrive(requestId),
    staleTime: REDRIVE_POLL_MS,
    retry: false,
    refetchInterval: (query) => {
      const { data, error } = query.state;
      if (data === undefined || isRedriveFinished(data) || isFatalProgressError(error)) {
        return false;
      }

      return stepOf(data) === expiredStep ? false : REDRIVE_POLL_MS;
    },
  });

  const redrive = requestId === null ? null : (progress.data ?? null);
  const finishedId = redrive !== null && isRedriveFinished(redrive) ? redrive.id : null;
  const step = redrive === null || finishedId !== null ? null : stepOf(redrive);
  const stop = stopOf(step, progress.error, expiredStep);

  useEffect(() => {
    if (step === null || step === expiredStep) return;

    const timer = setTimeout(() => {
      setExpiredStep(step);
    }, REDRIVE_WAIT_LIMIT_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [step, expiredStep]);

  useEffect(() => {
    if (finishedId === null) return;

    void client.invalidateQueries({ queryKey: queryKeys.pipeline });
  }, [client, finishedId]);

  return {
    start: (max: number) => {
      mutation.mutate(max);
    },
    sending: mutation.isPending,
    sendError: mutation.error,
    redrive,
    progressError: progress.error,
    stop,
    busy: mutation.isPending || (step !== null && stop === null),
  };
};
