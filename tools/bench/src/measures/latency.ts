import { formatDuration, formatNumber } from '../stats.js';
import type { Bench, Measure, MeasureResult, Row } from '../measure.js';
import { delayStats } from '../pipeline.js';
import type { DelayStats } from '../pipeline.js';

/** Предел ожидания выборки: события reading идут редко, но ждать их вечно замер не должен. */
const MIN_LIMIT_MS = 30_000;
const LIMIT_FACTOR = 2;

/** Задержка словами. Отрицательная означает, что часы шлюза и метка кадра разошлись. */
const delayText = (ms: number | null): string =>
  ms === null ? 'цифры нет' : ms < 0 ? `-${formatDuration(-ms)}` : formatDuration(ms);

/** Строка сводки: одна цифра разброса и та же команда повтора. */
const delayRow = (label: string, ms: number | null, how: string): Row => ({
  label,
  value: delayText(ms),
  how,
});

/** Строки отчёта по выборке. Пустая выборка это понятная строка, а не срыв замера. */
const rowsOf = (stats: DelayStats, how: string, limitMs: number): Row[] => {
  if (stats.count === 0) {
    return [
      {
        label: 'События reading',
        value: `не пришли за ${formatDuration(limitMs)}`,
        how,
        note: 'живой канал открылся, но кадров reading в нём не было: конвейер стоит или мост выключен настройкой SSE_BRIDGE',
      },
    ];
  }

  return [
    {
      label: 'Событий в выборке',
      value: `${formatNumber(stats.count)} кадров с ${formatNumber(stats.devices)} приборов`,
      how,
    },
    delayRow('Задержка p50', stats.p50, how),
    delayRow('Задержка p95', stats.p95, how),
    delayRow('Задержка p99', stats.p99, how),
    delayRow('Задержка минимум', stats.min, how),
    delayRow('Задержка максимум', stats.max, how),
  ];
};

/**
 * Задержка кадра до события живого канала. Часы контейнера и хоста расходятся, поэтому момент
 * приёма берётся уже приведённым к часам шлюза: поправку клиент считает по serverTime кадра hello
 * и заголовку x-server-time. Ключи подписки не задаются: нужны кадры любых приборов стенда.
 */
const run = async (bench: Bench): Promise<MeasureResult> => {
  const keys: readonly string[] = [];
  const limitMs = Math.max(MIN_LIMIT_MS, bench.config.windowMs * LIMIT_FACTOR);
  const how = bench.gateway.howListen(keys);
  bench.note(
    `ждём ${bench.config.samples} событий reading, но не дольше ${formatDuration(limitMs)}`,
  );

  const timer = bench.timer();
  const samples = await bench.gateway.listen({
    keys,
    kind: 'reading',
    count: bench.config.samples,
    limitMs,
    signal: bench.signal,
  });
  const stats = delayStats(samples);
  bench.note(
    `выборка ${stats.count} кадров собрана за ${timer.text()}, ` +
      `поправка локальных часов по времени шлюза ${formatNumber(bench.gateway.offsetMs())} мс`,
  );
  if (stats.count > 0 && stats.count < bench.config.samples) {
    bench.observe(
      `кадров пришло меньше заказанного: ${stats.count} из ${bench.config.samples} за ${formatDuration(limitMs)}`,
    );
  }

  return {
    rows: rowsOf(stats, how, limitMs),
    note:
      'Мерится сквозной путь сборщик → Kafka → процессор → шлюз → SSE: разница между полем ts ' +
      'кадра reading и моментом его приёма, приведённым к часам шлюза. События reading шлюз ' +
      'дросселирует до одного на прибор в секунду (READING_THROTTLE_MS в ' +
      'services/api-gateway/src/events/kafka-bridge.service.ts), поэтому ожидание такта дросселя ' +
      'входит в задержку, а частота событий не равна темпу записи показаний.',
  };
};

export const latency: Measure = {
  name: 'latency',
  title: 'задержка кадра до события живого канала',
  needs: ['gateway'],
  run,
};
