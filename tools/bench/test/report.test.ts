import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReport, errorText, formatTable } from '../src/report.js';
import type { RunFacts, Section } from '../src/report.js';

const FACTS: RunFacts = {
  baseUrl: 'http://localhost:8080',
  brokers: ['localhost:29092'],
  window: 'Окно замеров 1 мин 0 с, выборка событий 120',
  load: 'Нагрузочный режим выключен: стенд не менялся, только чтение.',
  tokenHow: 'TOKEN=$(curl -sS ... | jq -r .accessToken)',
  atIso: '2026-09-21T17:14:10.365Z',
  clock: 'по часам шлюза',
  dbAccess: 'через psql в контейнере стенда, порт базы наружу не опубликован',
};

const HOW = "docker stats --no-stream --format '{{.Name}}|{{.MemUsage}}' fieldstream-kafka-1";

const SECTION: Section = {
  name: 'memory',
  title: 'память и процессор контейнеров стенда',
  tookMs: 2_200,
  outcome: {
    kind: 'done',
    result: {
      rows: [
        {
          label: 'контейнер kafka',
          value: '741.3 МиБ из 1.0 ГиБ',
          how: HOW,
          note: 'предел памяти задан только брокеру',
        },
      ],
      note: 'Мгновенный снимок docker stats без усреднения.',
    },
  },
};

/** Строки, напечатанные протоколом за один вызов. */
const said = (call: () => void): string => {
  const lines: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  call();
  write.mockRestore();

  return lines.join('');
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('текст ошибки', () => {
  it('у отказа подключения берётся из списка причин, а не из пустого сообщения', () => {
    const refused = new AggregateError([new Error('connect ECONNREFUSED 127.0.0.1:5432')]);

    expect(errorText(refused)).toBe('connect ECONNREFUSED 127.0.0.1:5432');
    expect(errorText(new Error('psql ответил кодом 2'))).toBe('psql ответил кодом 2');
    expect(errorText(new Error(''))).toBe('без объяснения');
  });
});
describe('итоговая таблица', () => {
  it('несёт команду повтора с экранированной чертой: иначе она разорвёт ячейку', () => {
    const table = formatTable([SECTION], FACTS);

    expect(table).toContain('{{.Name}}\\|{{.MemUsage}}');
    expect(table).toContain('| `memory` | контейнер kafka | 741.3 МиБ из 1.0 ГиБ |');
    expect(table).toContain('- `memory`: Мгновенный снимок docker stats без усреднения.');
  });

  it('к прогону не относящееся в шапку не идёт: без шлюза ни окна, ни команды токена', () => {
    const bare = formatTable([SECTION], {
      ...FACTS,
      brokers: null,
      window: null,
      tokenHow: null,
    });

    expect(bare).not.toContain('Токен для команд');
    expect(bare).not.toContain('Окно замеров');
    expect(bare).not.toContain('Брокер');
    expect(formatTable([SECTION], FACTS)).toContain('Токен для команд');
  });

  it('часы называются те, с которых взят момент снятия', () => {
    const host = formatTable([SECTION], { ...FACTS, clock: 'по часам хоста' });

    expect(host).toContain('Снято 2026-09-21T17:14:10.365Z по часам хоста.');
    expect(formatTable([SECTION], FACTS)).toContain('по часам шлюза.');
  });

  it('у пропущенного замера в строке стоит причина, а не величина', () => {
    const skipped: Section = {
      ...SECTION,
      outcome: { kind: 'skipped', why: 'docker недоступен' },
    };

    expect(formatTable([skipped], FACTS)).toContain('| пропущен | docker недоступен |');
  });
});

describe('протокол прогона', () => {
  it('печатает команду повтора как есть: её вставляют в оболочку', () => {
    const text = said(() => {
      createReport().finish(SECTION);
    });

    expect(text).toContain(HOW);
    expect(text).not.toContain('\\|');
    expect(text).toContain('контейнер kafka: 741.3 МиБ из 1.0 ГиБ');
  });

  it('печатает оговорку строки рядом с её цифрой, а не только в таблице', () => {
    const text = said(() => {
      createReport().finish(SECTION);
    });

    expect(text).toContain('оговорка: предел памяти задан только брокеру');
  });
});
