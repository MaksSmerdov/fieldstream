import { performance } from 'node:perf_hooks';
import type { Measure, MeasureName, MeasureResult, Row, Timer } from './measure.js';
import { formatDuration } from './stats.js';

/** Чем кончился замер: снят, пропущен из-за недоступного средства или сорвался. */
export type Outcome =
  | { readonly kind: 'done'; readonly result: MeasureResult }
  | { readonly kind: 'skipped'; readonly why: string }
  | { readonly kind: 'failed'; readonly why: string };

/** Итог одного замера для протокола и таблицы. */
export interface Section {
  readonly name: MeasureName;
  readonly title: string;
  readonly tookMs: number;
  readonly outcome: Outcome;
}

/**
 * Обстоятельства прогона, известные до подключения средств: они открывают протокол. Пустое
 * поле значит, что к этому прогону обстоятельство не относится: брокер без замеров по Kafka,
 * окно без замеров по времени, токен без обращений к шлюзу. Лишнее в шапке вводит в
 * заблуждение так же, как неверная цифра в таблице.
 */
export interface HeadFacts {
  readonly baseUrl: string;
  readonly brokers: readonly string[] | null;
  readonly window: string | null;
  readonly load: string;
  readonly tokenHow: string | null;
}

/**
 * Обстоятельства прогона целиком: добавляются момент снятия, чьи это часы и способ доступа
 * к базе. Часы называются прямо: без шлюза момент берётся с часов хоста, а они с часами
 * контейнеров расходятся, и выдавать их за часы стенда нельзя.
 */
export interface RunFacts extends HeadFacts {
  readonly atIso: string;
  readonly clock: string;
  readonly dbAccess: string;
}

/**
 * Протокол прогона. Этот вывод идёт в документацию, поэтому строки пишутся как записи
 * журнала замеров, а не как отладочный лог.
 */
export interface Report {
  readonly head: (facts: HeadFacts, measures: readonly Measure[]) => void;
  readonly start: (measure: Measure) => void;
  readonly note: (text: string) => void;
  readonly observe: (text: string) => void;
  readonly finish: (section: Section) => void;
  readonly foot: (took: string, sections: readonly Section[]) => void;
}

/**
 * Текст ошибки для протокола. У AggregateError своего сообщения нет: отказ подключения
 * приходит списком причин, и без их разбора в протоколе оставались бы пустые скобки.
 */
export const errorText = (error: unknown): string => {
  const text =
    error instanceof AggregateError && error.message === ''
      ? error.errors.map((item: unknown) => errorText(item)).join('; ')
      : error instanceof Error
        ? error.message
        : String(error);

  return text.trim() === '' ? 'без объяснения' : text.trim();
};

/** Секундомер от текущего момента: часы монотонные, поэтому годятся для замера длительности. */
export const startTimer = (): Timer => {
  const from = performance.now();
  const ms = (): number => performance.now() - from;

  return { ms, text: () => formatDuration(ms()) };
};

/** Строка протокола. */
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** Текст в одну строку: в команду для ручного повтора перевод строки не влезает. */
const inline = (text: string): string => text.replace(/\s*\r?\n\s*/g, ' ').trim();

/**
 * Текст ячейки таблицы Markdown. Черта экранируется только здесь: в протоколе команда
 * печатается как есть, иначе её нельзя было бы вставить в оболочку и повторить.
 */
const cell = (text: string): string => inline(text).replace(/\|/g, '\\|');

/** Оговорки к цифрам: сначала общая по замеру, затем по отдельным строкам. */
const notesOf = (section: Section): string[] => {
  if (section.outcome.kind !== 'done') return [];

  const { result } = section.outcome;
  const own = result.note === undefined ? [] : [`- \`${section.name}\`: ${cell(result.note)}`];
  const rows = result.rows.flatMap((row) =>
    row.note === undefined ? [] : [`- \`${section.name}\`, ${cell(row.label)}: ${cell(row.note)}`],
  );

  return [...own, ...rows];
};

/** Строки таблицы одного замера. У пропущенного и сорвавшегося строка одна, с причиной. */
const tableRowsOf = (section: Section): string[] => {
  if (section.outcome.kind === 'done') {
    return section.outcome.result.rows.map(
      (row) =>
        `| \`${section.name}\` | ${cell(row.label)} | ${cell(row.value)} | \`${cell(row.how)}\` |`,
    );
  }

  const word = section.outcome.kind === 'skipped' ? 'пропущен' : 'сорвался';
  return [
    `| \`${section.name}\` | ${cell(section.title)} | ${word} | ${cell(section.outcome.why)} |`,
  ];
};

/**
 * Итоговая таблица Markdown. Столбец «Как повторить» несёт команду или SQL, которой ту же цифру
 * снимают руками без этого инструмента: без него цифра в документацию не идёт.
 */
export const formatTable = (sections: readonly Section[], facts: RunFacts): string => {
  const rows = sections.flatMap(tableRowsOf);
  const notes = sections.flatMap(notesOf);
  const table =
    rows.length === 0
      ? ['Ни один замер не снят.', '']
      : [
          '| Замер | Что измерено | Величина | Как повторить |',
          '| --- | --- | --- | --- |',
          ...rows,
          '',
        ];

  const broker = facts.brokers === null ? '' : ` Брокер ${facts.brokers.join(', ')}.`;

  return [
    '### Замеры стенда',
    '',
    `Снято ${facts.atIso} ${facts.clock}. Стенд ${facts.baseUrl}, база ${facts.dbAccess}.${broker}`,
    `${facts.window === null ? '' : `${facts.window}. `}${facts.load}`,
    ...(facts.tokenHow === null ? [] : [`Токен для команд ниже: \`${facts.tokenHow}\`.`]),
    '',
    ...table,
    ...(notes.length === 0 ? [] : ['Оговорки:', '', ...notes, '']),
  ].join('\n');
};

/** Итог замера словами: снятые строки, причина пропуска или причина срыва. */
const finishLines = (section: Section): string[] => {
  const took = formatDuration(section.tookMs);
  if (section.outcome.kind === 'skipped') {
    return [`  Замер пропущен: ${section.outcome.why}`];
  }
  if (section.outcome.kind === 'failed') {
    return [`  Замер сорвался за ${took}: ${section.outcome.why}`];
  }

  const { result } = section.outcome;
  const values = result.rows.flatMap((row: Row) => [
    `  ${row.label}: ${row.value}`,
    `    повтор: ${inline(row.how)}`,
    ...(row.note === undefined ? [] : [`    оговорка: ${inline(row.note)}`]),
  ]);

  return [
    ...values,
    ...(result.note === undefined ? [] : [`  ${result.note}`]),
    `  Замер снят за ${took}.`,
  ];
};

/** Протокол одного прогона: шапка, замеры по очереди и итог. */
export const createReport = (): Report => ({
  head: (facts, measures) => {
    say(`Замеры стенда ${facts.baseUrl}: ${measures.map((item) => item.name).join(', ')}`);
    if (facts.brokers !== null) say(`Брокер ${facts.brokers.join(', ')}.`);
    if (facts.window !== null) say(`${facts.window}.`);
    say(facts.load);
    if (facts.tokenHow !== null) say(`Токен для команд повтора: ${facts.tokenHow}`);
  },
  start: (measure) => {
    say('');
    say(`${measure.name}: ${measure.title}`);
  },
  note: (text) => {
    say(`  ${text}`);
  },
  observe: (text) => {
    say(`  Наблюдение: ${text}`);
  },
  finish: (section) => {
    for (const line of finishLines(section)) say(line);
  },
  foot: (took, sections) => {
    const done = sections.filter((section) => section.outcome.kind === 'done').length;
    say('');
    say(`Снято ${done} замеров из ${sections.length}, прогон занял ${took}.`);
  },
});
