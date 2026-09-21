import { describe, expect, it } from 'vitest';
import { howRequest, messageOf, parseFrame } from '../src/gateway.js';

const HELLO = [
  'event: hello',
  'id: 1',
  'data: {"serverTime":"2026-09-21T17:14:10.365Z","epoch":3,"pingMs":15000}',
].join('\n');

const READING = [
  'event: reading',
  'id: 42',
  'data: {"deviceCode":"RC-101","ts":"2026-09-21T17:14:11.000Z","mode":"cooling","quality":"ok","metrics":{"t":4.5}}',
].join('\n');

describe('разбор кадра живого канала', () => {
  it('кадр hello отдаёт время шлюза: по нему считается поправка часов', () => {
    const frame = parseFrame(HELLO);

    expect(frame?.kind).toBe('hello');
    expect(frame?.kind === 'hello' ? frame.data.serverTime : null).toBe('2026-09-21T17:14:10.365Z');
  });

  it('кадр reading отдаёт прибор и метку времени: из них и выходит задержка', () => {
    const frame = parseFrame(READING);

    expect(frame?.kind === 'reading' ? frame.data.deviceCode : null).toBe('RC-101');
    expect(frame?.kind === 'reading' ? frame.data.ts : null).toBe('2026-09-21T17:14:11.000Z');
  });

  it('строка-комментарий и поле без двоеточия кадром не считаются', () => {
    expect(parseFrame(': keep-alive')).toBeNull();
    expect(parseFrame('event')).toBeNull();
  });

  it('несколько строк data склеиваются переводом строки в одно тело', () => {
    const split = [
      'event: ping',
      'id: 7',
      'data: {"at":',
      'data: "2026-09-21T17:14:10.365Z"}',
    ].join('\n');

    expect(parseFrame(split)?.kind).toBe('ping');
  });

  it('кадр не по контракту и кадр без тела читаются как отсутствие кадра', () => {
    expect(parseFrame('event: reading\nid: 1\ndata: {"deviceCode":"RC-101"}')).toBeNull();
    expect(parseFrame('event: reading\nid: 1')).toBeNull();
  });

  it('вид кадра берётся из поля event, а не угадывается по телу', () => {
    const alien = READING.replace('event: reading', 'event: device-state');

    expect(parseFrame(alien)).toBeNull();
    expect(parseFrame(READING)?.kind).toBe('reading');
  });
});

describe('сообщение об отказе шлюза', () => {
  it('берётся из тела ответа, а из чужого тела не выдумывается', () => {
    expect(messageOf({ message: 'вход запрещён' })).toBe('вход запрещён');
    expect(messageOf({ message: '' })).toBeNull();
    expect(messageOf({ message: ['слишком коротко'] })).toBeNull();
    expect(messageOf(null)).toBeNull();
    expect(messageOf('отказ')).toBeNull();
  });
});

describe('команда повтора запроса', () => {
  it('у чтения идёт без метода и тела, у команды с телом и заголовком', () => {
    expect(howRequest('http://localhost:8080', 'GET', '/api/lab/lines')).toBe(
      "curl -sS -D - http://localhost:8080/api/lab/lines -H 'authorization: Bearer $TOKEN'",
    );
    expect(
      howRequest('http://localhost:8080', 'POST', '/api/commands', {
        kind: 'line.set_poll_interval',
      }),
    ).toContain(`-X POST http://localhost:8080/api/commands`);
  });
});
