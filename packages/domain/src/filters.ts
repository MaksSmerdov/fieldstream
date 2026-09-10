/** Состояние фильтра скачков: что принято и какой кандидат ждёт подтверждения. */
export interface SpikeFilterState {
  accepted: number | null;
  candidate: number | null;
  candidateCycles: number;
}

export interface SpikeFilterConfig {
  /** Допустимое отклонение от принятого значения. */
  maxDelta: number;
  /** Сколько подряд подтверждений принимают новый уровень. */
  acceptAfter: number;
}

export interface SpikeFilterResult {
  /** Принятое значение: при отбросе это предыдущее принятое. */
  value: number | null;
  rejected: boolean;
  state: SpikeFilterState;
}

/** Исходное состояние фильтра: первое пришедшее значение принимается как есть. */
export const idleSpikeFilterState = (): SpikeFilterState => ({
  accepted: null,
  candidate: null,
  candidateCycles: 0,
});

/**
 * Отбрасывает выброс датчика: значение дальше maxDelta от принятого не проходит,
 * пока новый уровень не подтвердится acceptAfter раз подряд. Состояние возвращается наружу.
 */
export const spikeFilter = (
  state: SpikeFilterState,
  value: number | null,
  config: SpikeFilterConfig,
): SpikeFilterResult => {
  if (value === null) {
    return { value: null, rejected: false, state };
  }

  if (state.accepted === null || Math.abs(value - state.accepted) <= config.maxDelta) {
    return {
      value,
      rejected: false,
      state: { accepted: value, candidate: null, candidateCycles: 0 },
    };
  }

  const cycles =
    state.candidate !== null && Math.abs(value - state.candidate) <= config.maxDelta
      ? state.candidateCycles + 1
      : 1;

  if (cycles >= config.acceptAfter) {
    return {
      value,
      rejected: false,
      state: { accepted: value, candidate: null, candidateCycles: 0 },
    };
  }

  return {
    value: state.accepted,
    rejected: true,
    state: { accepted: state.accepted, candidate: value, candidateCycles: cycles },
  };
};
