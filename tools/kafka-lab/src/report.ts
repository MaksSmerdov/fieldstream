import { performance } from 'node:perf_hooks';
import type { Experiment, LabTimer } from './experiment.js';

/** Что убрано за опытом. */
export interface Removed {
  readonly topics: number;
  readonly groups: number;
}

/**
 * Протокол опыта: шаг, наблюдение, вывод. Этот вывод идёт в документацию, поэтому строки
 * пишутся как записи в журнале опыта, а не как отладочный лог.
 */
export interface Report {
  readonly head: (experiment: Experiment, brokers: readonly string[]) => void;
  readonly step: (text: string) => void;
  readonly observe: (text: string) => void;
  readonly note: (text: string) => void;
  readonly conclude: (text: string) => void;
  readonly foot: (took: string, removed: Removed) => void;
}

/** Длительность словами: 850 мс, 4.2 с, 1 мин 20 с. */
export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)} мс`;

  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} с`;

  const minutes = Math.floor(seconds / 60);
  return `${minutes} мин ${Math.round(seconds - minutes * 60)} с`;
};

/** Секундомер от текущего момента: часы монотонные, поэтому годятся для замера длительности. */
export const startTimer = (): LabTimer => {
  const from = performance.now();
  const ms = (): number => performance.now() - from;

  return { ms, text: () => formatDuration(ms()) };
};

/** Строка протокола. */
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** Протокол одного прогона: нумерует шаги и отбивает их пустой строкой. */
export const createReport = (): Report => {
  let steps = 0;

  return {
    head: (experiment, brokers) => {
      say(`Опыт ${experiment.name}: ${experiment.title}`);
      say(`Брокер: ${brokers.join(', ')}`);
    },
    step: (text) => {
      steps += 1;
      say('');
      say(`Шаг ${steps}. ${text}`);
    },
    observe: (text) => {
      say(`  Наблюдение: ${text}`);
    },
    note: (text) => {
      say(`  ${text}`);
    },
    conclude: (text) => {
      say('');
      say(`Вывод: ${text}`);
    },
    foot: (took, removed) => {
      say('');
      say(
        `Опыт занял ${took}. Убрано: топиков ${removed.topics}, групп потребителей ${removed.groups}.`,
      );
    },
  };
};
