import { create } from 'zustand';

export type LiveStatus = 'connecting' | 'live' | 'offline';

/**
 * Состояние живого канала. Экраны обязаны отличать «данных нет» от «канал молчит»:
 * во втором случае показанные числа верны, но их возраст надо честно назвать.
 */
export interface LiveState {
  readonly status: LiveStatus;
  /** Серверное время последнего кадра. По нему баннер пишет, с какого момента данные. */
  readonly lastFrameAtMs: number | null;
  readonly epoch: number | null;
  readonly lastEventId: string | null;
  /** Сколько раз канал просил перечитать всё: видно и в интерфейсе, и в тестах. */
  readonly resyncCount: number;
  readonly setStatus: (status: LiveStatus) => void;
  readonly noteFrame: (id: string | null, atMs: number) => void;
  readonly noteHello: (epoch: number) => void;
  readonly noteResync: () => void;
}

export const useLiveStore = create<LiveState>((set) => ({
  status: 'connecting',
  lastFrameAtMs: null,
  epoch: null,
  lastEventId: null,
  resyncCount: 0,
  setStatus: (status) => {
    set({ status });
  },
  noteFrame: (id, atMs) => {
    set((state) => ({
      status: 'live',
      lastFrameAtMs: atMs,
      lastEventId: id ?? state.lastEventId,
    }));
  },
  noteHello: (epoch) => {
    set({ epoch });
  },
  noteResync: () => {
    set((state) => ({ resyncCount: state.resyncCount + 1 }));
  },
}));

export const lastEventIdNow = (): string | null => useLiveStore.getState().lastEventId;
