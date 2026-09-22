import { describe, expect, it } from 'vitest';
import { collectSlugs, headingText, slugify } from '../src/slug.js';

describe('якорь заголовка по правилам GitHub', () => {
  it('кириллица остаётся, регистр снижается, пробелы становятся дефисами', () => {
    expect(slugify('Как это масштабируется')).toBe('как-это-масштабируется');
    expect(slugify('Границы Сервисов')).toBe('границы-сервисов');
  });

  it('знаки препинания выбрасываются, дефис и подчёркивание остаются', () => {
    expect(slugify('1. Мёртвый прибор и размыкатель')).toBe('1-мёртвый-прибор-и-размыкатель');
    expect(slugify('Мусор в топике, очередь и повторная подача')).toBe(
      'мусор-в-топике-очередь-и-повторная-подача',
    );
    expect(slugify('edge-collector')).toBe('edge-collector');
    expect(slugify('SIM_SPEED и SIM_SEED')).toBe('sim_speed-и-sim_seed');
    expect(slugify('«Замеры»')).toBe('замеры');
    expect(slugify('Что дальше?')).toBe('что-дальше');
  });

  it('косая черта и точка выбрасываются без замены на дефис', () => {
    expect(slugify('docs/adr')).toBe('docsadr');
    expect(slugify('pnpm format:check')).toBe('pnpm-formatcheck');
  });

  it('стрелка и длинное тире выбрасываются, окружающие пробелы дают двойной дефис', () => {
    expect(slugify('Modbus TCP → Kafka')).toBe('modbus-tcp--kafka');
    expect(slugify('Хранилище — почему TimescaleDB')).toBe('хранилище--почему-timescaledb');
  });

  it('теги HTML выбрасываются вместе с содержимым угловых скобок', () => {
    expect(slugify('Заголовок <a name="x"></a>')).toBe('заголовок-');
  });

  it('повторный заголовок получает номер', () => {
    expect(collectSlugs(['Добавлено', 'Изменено', 'Добавлено', 'Добавлено'])).toEqual([
      'добавлено',
      'изменено',
      'добавлено-1',
      'добавлено-2',
    ]);
  });
});

describe('текст заголовка', () => {
  it('решётки в начале и в конце убираются', () => {
    expect(headingText('### Замеры')).toBe('Замеры');
    expect(headingText('## Замеры ##')).toBe('Замеры');
  });

  it('код в обратных кавычках остаётся текстом, кавычки выбросит уже якорь', () => {
    expect(slugify(headingText('## Команда `pnpm bench`'))).toBe('команда-pnpm-bench');
  });

  it('от ссылки в заголовке остаётся подпись, адрес в якорь не попадает', () => {
    expect(slugify(headingText('## Смотри [ADR](docs/adr)'))).toBe('смотри-adr');
    expect(slugify(headingText('## [Не выпущено]'))).toBe('не-выпущено');
    expect(slugify(headingText('## [0.7] - 2026-09-16'))).toBe('07---2026-09-16');
  });
});
