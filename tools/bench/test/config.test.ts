import { describe, expect, it } from 'vitest';
import { DEFAULT_LOAD_MS, parseBrokers, parseConfig, parseOptions } from '../src/config.js';

describe('разбор окружения', () => {
  it('без переменных берутся стенд на 8080, база на localhost и брокер на 29092', () => {
    expect(parseConfig({ FS_API_PASSWORD: 'secret' })).toEqual({
      ok: true,
      config: {
        baseUrl: 'http://localhost:8080',
        email: 'engineer@fieldstream.local',
        password: 'fieldstream',
        target: { host: 'localhost', port: 5432, database: 'fieldstream' },
        apiPassword: 'secret',
        brokers: ['localhost:29092'],
        windowMs: 60_000,
        samples: 120,
      },
    });
  });

  it('без пароля читающей роли настройки собираются: он нужен только замерам по базе', () => {
    const parsed = parseConfig({});

    expect(parsed).toMatchObject({ ok: true, config: { apiPassword: null } });
  });

  it('пустые переменные читаются как не заданные, косая черта в конце адреса срезается', () => {
    const parsed = parseConfig({
      BENCH_BASE_URL: 'http://127.0.0.1:8080/',
      BENCH_PASSWORD: '',
      DATABASE_PORT: '5433',
      BENCH_WINDOW_MS: '30000',
      KAFKA_BROKERS: 'localhost:29092, kafka:9092',
      FS_API_PASSWORD: 'secret',
    });

    expect(parsed).toMatchObject({
      ok: true,
      config: {
        baseUrl: 'http://127.0.0.1:8080',
        password: 'fieldstream',
        target: { port: 5433 },
        brokers: ['localhost:29092', 'kafka:9092'],
        windowMs: 30_000,
      },
    });
  });

  it('неверный адрес стенда возвращается списком, а не исключением', () => {
    const parsed = parseConfig({ BENCH_BASE_URL: 'localhost', FS_API_PASSWORD: 'secret' });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.join(' ')).toContain('BENCH_BASE_URL');
  });

  it('список брокеров разбирается через запятую без пустых элементов', () => {
    expect(parseBrokers('localhost:29092, , kafka:9092')).toEqual([
      'localhost:29092',
      'kafka:9092',
    ]);
  });
});

describe('разбор командной строки', () => {
  it('без аргументов берутся все замеры и стенд не меняется', () => {
    expect(parseOptions([])).toEqual({
      ok: true,
      options: { names: [], outPath: null, load: false, loadMs: DEFAULT_LOAD_MS, help: false },
    });
  });

  it('имена замеров запоминаются в порядке запроса и без повторов', () => {
    const parsed = parseOptions(['lag', 'throughput', 'lag']);

    expect(parsed).toEqual({
      ok: true,
      options: {
        names: ['lag', 'throughput'],
        outPath: null,
        load: false,
        loadMs: DEFAULT_LOAD_MS,
        help: false,
      },
    });
  });

  it('нагрузочный режим и путь для таблицы читаются флагами', () => {
    const parsed = parseOptions(['latency', '--load', '--load-ms', '2000', '--out', 'bench.md']);

    expect(parsed).toEqual({
      ok: true,
      options: {
        names: ['latency'],
        outPath: 'bench.md',
        load: true,
        loadMs: 2_000,
        help: false,
      },
    });
  });

  it('такт без --load это отказ: без --load инструмент стенд не меняет', () => {
    const parsed = parseOptions(['--load-ms', '2000']);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.join(' ')).toContain('--load');
  });

  it('такт вне пределов команды смены опроса не принимается', () => {
    expect(parseOptions(['--load', '--load-ms', '10']).ok).toBe(false);
    expect(parseOptions(['--load', '--load-ms', '900000']).ok).toBe(false);
  });

  it('чужое имя и чужой флаг объясняются, а не молчат', () => {
    const parsed = parseOptions(['throughput', 'disk', '--fast']);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toHaveLength(2);
    expect(parsed.issues.join(' ')).toContain('disk');
    expect(parsed.issues.join(' ')).toContain('--fast');
  });

  it('просьба о списке замеров разбирается и без прочих аргументов', () => {
    expect(parseOptions(['-h'])).toMatchObject({ ok: true, options: { help: true } });
    expect(parseOptions(['--help'])).toMatchObject({ ok: true, options: { help: true } });
  });
});
