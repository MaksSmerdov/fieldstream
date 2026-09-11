/** Состояние размыкателя в терминах события цикла опроса. */
export type BreakerView = 'closed' | 'open' | 'half_open';

/** Размыкатель одного источника, ключ `линия:адрес`. */
export interface Breaker {
  readonly failures: number;
  readonly open: boolean;
  readonly probeDelayMs: number;
  readonly nextProbeAt: number | null;
}

/** Порог и лестница проб: два отказа подряд, затем проба через 30 с, удвоение, потолок 5 минут. */
export const BREAKER = Object.freeze({
  threshold: 2,
  firstProbeMs: 30_000,
  maxProbeMs: 300_000,
});

export const CLOSED_BREAKER: Breaker = Object.freeze({
  failures: 0,
  open: false,
  probeDelayMs: 0,
  nextProbeAt: null,
});

/** Можно ли сейчас обратиться к источнику: размыкатель закрыт или подошло время пробы. */
export const breakerAllows = (breaker: Breaker, now: number): boolean =>
  !breaker.open || (breaker.nextProbeAt !== null && now >= breaker.nextProbeAt);

/** Состояние для события цикла: открытый размыкатель с наступившей пробой считается полуоткрытым. */
export const breakerView = (breaker: Breaker, now: number): BreakerView => {
  if (!breaker.open) return 'closed';
  return breakerAllows(breaker, now) ? 'half_open' : 'open';
};

/** Успех закрывает размыкатель и обнуляет счёт отказов. */
export const recordSuccess = (): Breaker => CLOSED_BREAKER;

/**
 * Отказ. До порога только считается; на пороге источник уходит на редкую пробу,
 * а каждая неудачная проба удваивает паузу до потолка. Смысл в том, что мёртвый прибор
 * иначе съедает таймаут на каждом обходе и растягивает цикл всем живым соседям.
 */
export const recordFailure = (breaker: Breaker, now: number): Breaker => {
  const failures = breaker.failures + 1;

  if (breaker.open) {
    const probeDelayMs = Math.min(breaker.probeDelayMs * 2, BREAKER.maxProbeMs);
    return { failures, open: true, probeDelayMs, nextProbeAt: now + probeDelayMs };
  }

  if (failures < BREAKER.threshold) return { ...breaker, failures };

  return {
    failures,
    open: true,
    probeDelayMs: BREAKER.firstProbeMs,
    nextProbeAt: now + BREAKER.firstProbeMs,
  };
};
