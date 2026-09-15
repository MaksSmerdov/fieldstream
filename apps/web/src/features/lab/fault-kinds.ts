import type { SimFaultKind } from '@fieldstream/contracts';

export interface FaultOption {
  readonly kind: SimFaultKind;
  readonly label: string;
}

export const CHAMBER_PROFILE = 'rc-2000';

export const FAULT_LABEL: Readonly<Record<SimFaultKind, string>> = {
  silent: 'молчит',
  crc: 'мусор в кадре',
  stall: 'зависает',
  exception: 'исключение Modbus',
  offline: 'обрыв порта шлюза',
  power_dip: 'провал напряжения',
  offscale: 'значение за шкалой',
  door_stuck: 'дверь не закрывается',
  defrost: 'оттайка',
};

export const LINE_FAULTS: readonly FaultOption[] = [
  { kind: 'offline', label: FAULT_LABEL.offline },
  { kind: 'power_dip', label: FAULT_LABEL.power_dip },
];

const DEVICE_FAULTS: readonly FaultOption[] = [
  { kind: 'silent', label: FAULT_LABEL.silent },
  { kind: 'crc', label: FAULT_LABEL.crc },
  { kind: 'stall', label: FAULT_LABEL.stall },
  { kind: 'exception', label: FAULT_LABEL.exception },
  { kind: 'offscale', label: FAULT_LABEL.offscale },
  { kind: 'door_stuck', label: FAULT_LABEL.door_stuck },
];

/** Поломки, применимые к прибору данной модели. */
export const deviceFaults = (profileKey: string | null): readonly FaultOption[] =>
  profileKey === CHAMBER_PROFILE
    ? DEVICE_FAULTS
    : DEVICE_FAULTS.filter((option) => option.kind !== 'door_stuck');

export const ALL_FAULTS_KEY = 'all';

/** Ключ поломки по цели и виду. */
export const faultKey = (targetId: string, kind: SimFaultKind): string => `${targetId}:${kind}`;
