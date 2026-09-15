import type { Clock } from '@fieldstream/domain';
import type {
  SimClearFaultsQuery,
  SimFaultKind,
  SimFaultRequest,
  SimTargetKind,
} from '@fieldstream/contracts';

/** Внесённая поломка. Срок жизни идёт по реальным часам и не зависит от ускорения стенда. */
export interface ActiveFault {
  readonly id: string;
  readonly targetKind: SimTargetKind;
  readonly targetId: string;
  readonly kind: SimFaultKind;
  readonly sinceMs: number;
  readonly expiresAtMs: number;
  readonly exceptionCode: number | null;
  readonly paramKey: string | null;
}

export interface FaultBook {
  readonly add: (request: SimFaultRequest, paramKey: string | null) => ActiveFault;
  /** Снимает поломки под фильтр по коду цели и виду, без фильтра все. Возвращает число снятых. */
  readonly clear: (filter?: SimClearFaultsQuery) => number;
  readonly list: () => ActiveFault[];
  readonly affecting: (lineCode: string, deviceCode: string) => ActiveFault[];
  readonly onLine: (lineCode: string, kind: SimFaultKind) => boolean;
  readonly onDevice: (deviceCode: string, kind: SimFaultKind) => boolean;
}

/** Подходит ли поломка под фильтр снятия: цель сравнивается с тем, на что поломка внесена. */
const matches = (fault: ActiveFault, filter: SimClearFaultsQuery): boolean =>
  (filter.targetId === undefined || fault.targetId === filter.targetId) &&
  (filter.kind === undefined || fault.kind === filter.kind);

/** Журнал поломок. Повтор того же вида на ту же цель продлевает прежнюю поломку, а не копится. */
export const createFaultBook = (clock: Clock): FaultBook => {
  let faults: ActiveFault[] = [];
  let counter = 0;

  const active = (): readonly ActiveFault[] => {
    const now = clock.now();
    if (faults.some((fault) => fault.expiresAtMs <= now)) {
      faults = faults.filter((fault) => fault.expiresAtMs > now);
    }
    return faults;
  };

  const targets = (fault: ActiveFault, targetKind: SimTargetKind, targetId: string): boolean =>
    fault.targetKind === targetKind && fault.targetId === targetId;

  return {
    add: (request, paramKey) => {
      const now = clock.now();
      counter += 1;
      const fault: ActiveFault = {
        id: `fault-${String(counter)}`,
        targetKind: request.targetKind,
        targetId: request.targetId,
        kind: request.kind,
        sinceMs: now,
        expiresAtMs: now + request.ttlSec * 1000,
        exceptionCode: request.kind === 'exception' ? request.exceptionCode : null,
        paramKey,
      };

      faults = [
        ...active().filter(
          (existing) =>
            !(targets(existing, fault.targetKind, fault.targetId) && existing.kind === fault.kind),
        ),
        fault,
      ];
      return fault;
    },
    clear: (filter = {}) => {
      const current = active();
      faults = current.filter((fault) => !matches(fault, filter));
      return current.length - faults.length;
    },
    list: () => [...active()],
    affecting: (lineCode, deviceCode) =>
      active().filter(
        (fault) => targets(fault, 'line', lineCode) || targets(fault, 'device', deviceCode),
      ),
    onLine: (lineCode, kind) =>
      active().some((fault) => targets(fault, 'line', lineCode) && fault.kind === kind),
    onDevice: (deviceCode, kind) =>
      active().some((fault) => targets(fault, 'device', deviceCode) && fault.kind === kind),
  };
};
