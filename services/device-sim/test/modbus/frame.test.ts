import { describe, expect, it } from 'vitest';
import {
  MODBUS_EXCEPTION,
  exceptionResponse,
  lineTimeMs,
  parseRequest,
  registersResponse,
  rtuBytesOf,
  splitFrames,
} from '../../src/modbus/frame.js';

/** Кадр запроса чтения, как его отправляет клиент. */
const readFrame = (
  transactionId: number,
  unitId: number,
  functionCode: number,
  address: number,
  quantity: number,
): Buffer => {
  const frame = Buffer.alloc(12);
  frame.writeUInt16BE(transactionId, 0);
  frame.writeUInt16BE(0, 2);
  frame.writeUInt16BE(6, 4);
  frame.writeUInt8(unitId, 6);
  frame.writeUInt8(functionCode, 7);
  frame.writeUInt16BE(address, 8);
  frame.writeUInt16BE(quantity, 10);
  return frame;
};

describe('splitFrames', () => {
  it('режет склеенные кадры и оставляет незавершённый хвост до следующих байт', () => {
    const first = readFrame(1, 1, 4, 0, 4);
    const second = readFrame(2, 2, 3, 0, 1);
    const split = splitFrames(Buffer.concat([first, second.subarray(0, 5)]));

    expect(split.broken).toBe(false);
    expect(split.frames).toHaveLength(1);
    expect(split.frames[0]?.equals(first)).toBe(true);
    expect(split.rest.equals(second.subarray(0, 5))).toBe(true);

    const next = splitFrames(Buffer.concat([split.rest, second.subarray(5)]));
    expect(next.frames).toHaveLength(1);
    expect(next.frames[0]?.equals(second)).toBe(true);
    expect(next.rest).toHaveLength(0);
  });

  it('поток с чужим идентификатором протокола считается сломанным', () => {
    const frame = readFrame(1, 1, 4, 0, 1);
    frame.writeUInt16BE(7, 2);

    expect(splitFrames(frame).broken).toBe(true);
  });

  it('слишком короткая или слишком длинная заявленная длина считается сломанной', () => {
    const tiny = readFrame(1, 1, 4, 0, 1);
    tiny.writeUInt16BE(1, 4);
    const huge = readFrame(1, 1, 4, 0, 1);
    huge.writeUInt16BE(300, 4);

    expect(splitFrames(tiny).broken).toBe(true);
    expect(splitFrames(huge).broken).toBe(true);
  });
});

describe('parseRequest', () => {
  it('разбирает чтение входных и holding-регистров', () => {
    expect(parseRequest(readFrame(7, 3, 4, 16, 3))).toEqual({
      transactionId: 7,
      unitId: 3,
      functionCode: 4,
      kind: 'read',
      registerType: 'input',
      address: 16,
      quantity: 3,
    });
    expect(parseRequest(readFrame(8, 1, 3, 0, 1))).toMatchObject({
      kind: 'read',
      registerType: 'holding',
    });
  });

  it('неподдержанная функция получает исключение illegal function', () => {
    expect(parseRequest(readFrame(1, 1, 6, 0, 1))).toMatchObject({
      kind: 'rejected',
      exceptionCode: MODBUS_EXCEPTION.illegalFunction,
    });
  });

  it('количество вне 1..125 и выход за адресное пространство отвергаются', () => {
    expect(parseRequest(readFrame(1, 1, 3, 0, 0))).toMatchObject({
      kind: 'rejected',
      exceptionCode: MODBUS_EXCEPTION.illegalDataValue,
    });
    expect(parseRequest(readFrame(1, 1, 3, 0, 126))).toMatchObject({
      kind: 'rejected',
      exceptionCode: MODBUS_EXCEPTION.illegalDataValue,
    });
    expect(parseRequest(readFrame(1, 1, 3, 65_535, 2))).toMatchObject({
      kind: 'rejected',
      exceptionCode: MODBUS_EXCEPTION.illegalDataAddress,
    });
  });
});

describe('кадры ответа', () => {
  const header = { transactionId: 0x1234, unitId: 5, functionCode: 4 };

  it('ответ на чтение: MBAP, адрес, функция, счётчик байт и слова', () => {
    expect([...registersResponse(header, [0x0102, 0xfffe])]).toEqual([
      0x12, 0x34, 0, 0, 0, 7, 5, 4, 4, 0x01, 0x02, 0xff, 0xfe,
    ]);
  });

  it('искажённый ответ заявляет полный счётчик байт, но несёт на слово меньше', () => {
    const frame = registersResponse(header, [1, 2, 3], true);

    expect(frame.readUInt16BE(4)).toBe(7);
    expect(frame.readUInt8(8)).toBe(6);
    expect(frame).toHaveLength(13);
  });

  it('исключение: функция с поднятым старшим битом и код причины', () => {
    expect([...exceptionResponse(header, MODBUS_EXCEPTION.gatewayTargetFailed)]).toEqual([
      0x12, 0x34, 0, 0, 0, 3, 5, 0x84, 0x0b,
    ]);
  });
});

describe('время на линии', () => {
  it('11 байт на 9600 бод передаются чуть дольше 12.6 мс', () => {
    expect(lineTimeMs(11, 9600)).toBeCloseTo(12.604, 2);
  });

  it('байты ответа в линии считаются без MBAP, но с адресом и CRC', () => {
    const frame = registersResponse({ transactionId: 1, unitId: 1, functionCode: 3 }, [1, 2]);

    expect(rtuBytesOf(frame)).toBe(9);
  });
});
