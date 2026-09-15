import { TOPICS } from '@fieldstream/contracts';
import { partitionForKey } from '@fieldstream/kafka';

/** Группа процессора: сырые кадры и циклы опроса читает один потребитель. */
export const INGEST_GROUP = 'fs-processor';

/**
 * Приборы, чьи кадры лежат в назначенных партициях сырого топика. Циклы разложены тем же ключом
 * по тому же числу партиций, а назначатель отдаёт партиции с одним номером одному участнику,
 * поэтому циклы этих приборов приходят сюда же.
 */
export const ownedDevices = (
  deviceCodes: readonly string[],
  rawPartitions: readonly number[],
): Set<string> => {
  const assigned = new Set(rawPartitions);
  return new Set(
    deviceCodes.filter((code) =>
      assigned.has(partitionForKey(code, TOPICS.telemetryRaw.partitions)),
    ),
  );
};

export interface Handover {
  readonly released: string[];
  readonly adopted: string[];
}

/** Разница двух назначений: kafkajs сообщает только новое, а отобранное приходится вычислять. */
export const handoverOf = (prev: ReadonlySet<string>, next: ReadonlySet<string>): Handover => ({
  released: [...prev].filter((code) => !next.has(code)),
  adopted: [...next].filter((code) => !prev.has(code)),
});

/** Чем экземпляр владеет после последнего применённого назначения. */
export interface Ownership {
  readonly partitions: readonly number[];
  readonly devices: ReadonlySet<string>;
}

/** Что делает сервис при переезде приборов. */
export interface HandoverSteps {
  readonly codes: () => readonly string[];
  readonly release: (deviceCodes: readonly string[]) => void;
  readonly adopt: (deviceCodes: readonly string[]) => Promise<void>;
  readonly settled: (ownership: Ownership | null, handover: Handover) => void;
  readonly failed: (error: unknown) => void;
}

/**
 * Очередь переездов. Шаги возвращают промис своего завершения и никогда не отклоняются, ready()
 * ждёт всю очередь, и пачки не обрабатываются, пока состояние не переехало. announce() отмечает
 * начавшийся ребаланс, а settling() верно с этого момента и до конца очередного назначения:
 * пока оно верно, экземпляр не публикует здоровье.
 */
export interface Handovers {
  readonly announce: () => void;
  readonly assign: (memberId: string, rawPartitions: readonly number[]) => Promise<void>;
  readonly revoke: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly ready: () => Promise<void>;
  readonly settling: () => boolean;
  readonly ownership: () => Ownership | null;
}

interface Membership {
  readonly memberId: string;
  readonly partitions: readonly number[];
}

/**
 * Очередь переездов приборов. Назначения применяются строго по очереди. Если экземпляр выпал
 * из группы (падение потребителя, остановка) или вернулся в неё под другим memberId, всё прежнее
 * считается отобранным: пока его не было, приборы мог вести другой экземпляр, и та же раскладка
 * после возвращения всё равно требует восстановления из базы.
 */
export const createHandovers = (steps: HandoverSteps): Handovers => {
  let owned: ReadonlySet<string> = new Set();
  let member: Membership | null = null;
  let settled: Ownership | null = null;
  let queue: Promise<void> = Promise.resolve();
  let rebalancing = false;
  let pending = 0;

  const apply = async (target: Membership | null): Promise<void> => {
    const kept: ReadonlySet<string> =
      target !== null && target.memberId === member?.memberId ? owned : new Set();
    const next =
      target === null ? new Set<string>() : ownedDevices(steps.codes(), target.partitions);
    const dropped = handoverOf(owned, kept).released;
    const { released, adopted } = handoverOf(kept, next);
    const gone = [...dropped, ...released];

    owned = next;
    member = target;
    if (gone.length > 0) steps.release(gone);
    await steps.adopt(adopted);
    settled = target === null ? null : { partitions: target.partitions, devices: next };
    steps.settled(settled, { released: gone, adopted });
  };

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    pending += 1;
    queue = queue
      .then(work)
      .catch((error: unknown) => {
        steps.failed(error);
      })
      .finally(() => {
        pending -= 1;
      });
    return queue;
  };

  return {
    announce: () => {
      rebalancing = true;
    },
    assign: (memberId, rawPartitions) => {
      rebalancing = false;
      return enqueue(() =>
        apply({ memberId, partitions: [...rawPartitions].sort((left, right) => left - right) }),
      );
    },
    revoke: () => {
      rebalancing = false;
      return enqueue(() => (member === null && owned.size === 0 ? Promise.resolve() : apply(null)));
    },
    refresh: () => enqueue(() => (member === null ? Promise.resolve() : apply(member))),
    ready: () => queue,
    settling: () => rebalancing || pending > 0,
    ownership: () => settled,
  };
};
