/** Вид события живого канала. По нему же считается право на его получение. */
export type LiveEventKind = 'reading' | 'device-state' | 'alarm' | 'ping' | 'hello';

export interface LiveEvent {
  /** Монотонный идентификатор вида «эпоха:номер». Эпоха меняется при перезапуске шлюза. */
  readonly id: string;
  readonly kind: LiveEventKind;
  /** Ключи маршрутизации: `device:RC-101`, `site:SITE-A`, `role:engineer`. */
  readonly keys: readonly string[];
  readonly data: object;
}

/** Что отдать подключившемуся клиенту: досылку пропущенного или требование перечитать всё. */
export interface Backfill {
  readonly events: readonly LiveEvent[];
  readonly resync: boolean;
  readonly reason: 'unknown_epoch' | 'too_old' | null;
}

const parseId = (value: string): { epoch: number; seq: number } | null => {
  const [epoch, seq] = value.split(':');
  if (epoch === undefined || seq === undefined) return null;
  const parsedEpoch = Number(epoch);
  const parsedSeq = Number(seq);
  if (!Number.isFinite(parsedEpoch) || !Number.isFinite(parsedSeq)) return null;

  return { epoch: parsedEpoch, seq: parsedSeq };
};

/**
 * Кольцо последних событий. Нужно ровно для одного: клиент, у которого оборвалось соединение,
 * должен либо получить пропущенное, либо узнать, что пропустил слишком много. Молчаливая
 * потеря событий хуже обоих вариантов, поэтому третьего исхода у `since` нет.
 */
export class LiveRing {
  private readonly buffer: LiveEvent[] = [];
  private seq = 0;

  public constructor(
    private readonly capacity: number,
    private readonly epoch: number,
  ) {}

  public get currentEpoch(): number {
    return this.epoch;
  }

  /** Текущая позиция кольца. С ней клиент возвращается после обрыва, даже если событий не видел. */
  public currentId(): string {
    return `${String(this.epoch)}:${String(this.seq)}`;
  }

  public append(kind: LiveEventKind, keys: readonly string[], data: object): LiveEvent {
    this.seq += 1;
    const event: LiveEvent = { id: `${String(this.epoch)}:${String(this.seq)}`, kind, keys, data };

    this.buffer.push(event);
    if (this.buffer.length > this.capacity) this.buffer.shift();

    return event;
  }

  public size(): number {
    return this.buffer.length;
  }

  /**
   * Что клиент пропустил с указанного идентификатора. Чужая эпоха означает перезапуск шлюза,
   * слишком старый номер означает, что события уже вытеснены: в обоих случаях клиенту нужен
   * полный перезапрос, а не тишина.
   */
  public since(lastEventId: string | null): Backfill {
    if (lastEventId === null) return { events: [], resync: false, reason: null };

    const parsed = parseId(lastEventId);
    if (parsed === null || parsed.epoch !== this.epoch) {
      return { events: [], resync: true, reason: 'unknown_epoch' };
    }
    if (parsed.seq > this.seq) return { events: [], resync: true, reason: 'unknown_epoch' };

    const oldest = this.buffer[0];
    const oldestSeq = oldest === undefined ? this.seq : Number(oldest.id.split(':')[1] ?? 0);
    if (parsed.seq + 1 < oldestSeq) return { events: [], resync: true, reason: 'too_old' };

    return {
      events: this.buffer.filter((event) => Number(event.id.split(':')[1] ?? 0) > parsed.seq),
      resync: false,
      reason: null,
    };
  }
}
