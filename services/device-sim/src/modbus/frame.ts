import type { RegisterType } from '@fieldstream/contracts';

/** Коды исключений Modbus, которые отдаёт стенд. */
export const MODBUS_EXCEPTION = Object.freeze({
  illegalFunction: 0x01,
  illegalDataAddress: 0x02,
  illegalDataValue: 0x03,
  deviceFailure: 0x04,
  gatewayTargetFailed: 0x0b,
});

export interface FrameHeader {
  readonly transactionId: number;
  readonly unitId: number;
  readonly functionCode: number;
}

/** Запрос, разобранный из кадра Modbus TCP: чтение регистров или отказ с кодом исключения. */
export type ModbusRequest =
  | (FrameHeader & {
      readonly kind: 'read';
      readonly registerType: RegisterType;
      readonly address: number;
      readonly quantity: number;
    })
  | (FrameHeader & { readonly kind: 'rejected'; readonly exceptionCode: number });

/** Решение стенда по запросу. Задержка stallMs добавляется к честному времени обмена на линии. */
export type Answer =
  | { readonly kind: 'silent' }
  | { readonly kind: 'exception'; readonly code: number; readonly stallMs: number }
  | {
      readonly kind: 'registers';
      readonly words: readonly number[];
      readonly garbled: boolean;
      readonly stallMs: number;
    };

export type Reply = Exclude<Answer, { readonly kind: 'silent' }>;

export interface FrameSplit {
  readonly frames: Buffer[];
  readonly rest: Buffer;
  readonly broken: boolean;
}

const MBAP_BYTES = 6;
const MAX_PDU_BYTES = 253;
const READ_REQUEST_BYTES = 12;
const MAX_READ_REGISTERS = 125;

/** Запрос чтения в линии RS-485: адрес, функция, начальный регистр, количество, CRC. */
export const RTU_READ_REQUEST_BYTES = 8;

/** Нарезка входящего потока на кадры по заголовку MBAP. Незавершённый хвост ждёт следующих байт. */
export const splitFrames = (buffer: Buffer): FrameSplit => {
  const frames: Buffer[] = [];
  let offset = 0;

  while (buffer.length - offset >= MBAP_BYTES) {
    const protocolId = buffer.readUInt16BE(offset + 2);
    const length = buffer.readUInt16BE(offset + 4);
    if (protocolId !== 0 || length < 2 || length > MAX_PDU_BYTES + 1) {
      return { frames, rest: Buffer.alloc(0), broken: true };
    }

    const end = offset + MBAP_BYTES + length;
    if (end > buffer.length) break;

    frames.push(buffer.subarray(offset, end));
    offset = end;
  }

  return { frames, rest: buffer.subarray(offset), broken: false };
};

/** Разбор одного кадра. Поддержано только чтение регистров: большего стенду не нужно. */
export const parseRequest = (frame: Buffer): ModbusRequest => {
  const header: FrameHeader = {
    transactionId: frame.readUInt16BE(0),
    unitId: frame.readUInt8(6),
    functionCode: frame.readUInt8(7),
  };
  const reject = (exceptionCode: number): ModbusRequest => ({
    ...header,
    kind: 'rejected',
    exceptionCode,
  });

  if (header.functionCode !== 3 && header.functionCode !== 4) {
    return reject(MODBUS_EXCEPTION.illegalFunction);
  }
  if (frame.length !== READ_REQUEST_BYTES) return reject(MODBUS_EXCEPTION.illegalDataValue);

  const address = frame.readUInt16BE(8);
  const quantity = frame.readUInt16BE(10);
  if (quantity < 1 || quantity > MAX_READ_REGISTERS) {
    return reject(MODBUS_EXCEPTION.illegalDataValue);
  }
  if (address + quantity > 0x10000) return reject(MODBUS_EXCEPTION.illegalDataAddress);

  return {
    ...header,
    kind: 'read',
    registerType: header.functionCode === 3 ? 'holding' : 'input',
    address,
    quantity,
  };
};

/** Кадр ответа: заголовок MBAP, адрес прибора и PDU. */
const withHeader = (header: FrameHeader, pdu: Buffer): Buffer => {
  const frame = Buffer.alloc(MBAP_BYTES + 1 + pdu.length);
  frame.writeUInt16BE(header.transactionId, 0);
  frame.writeUInt16BE(0, 2);
  frame.writeUInt16BE(pdu.length + 1, 4);
  frame.writeUInt8(header.unitId, 6);
  pdu.copy(frame, MBAP_BYTES + 1);
  return frame;
};

/**
 * Ответ на чтение. Искажённый ответ заявляет столько байт, сколько просили, а слов несёт
 * на одно меньше: так выглядит кадр, побитый на линии за шлюзом без проверки CRC.
 */
export const registersResponse = (
  header: FrameHeader,
  words: readonly number[],
  garbled = false,
): Buffer => {
  const sent = garbled ? words.slice(0, -1) : words;
  const pdu = Buffer.alloc(2 + sent.length * 2);
  pdu.writeUInt8(header.functionCode, 0);
  pdu.writeUInt8(words.length * 2, 1);
  sent.forEach((word, index) => {
    pdu.writeUInt16BE(word, 2 + index * 2);
  });
  return withHeader(header, pdu);
};

/** Ответ-исключение: функция с поднятым старшим битом и код причины. */
export const exceptionResponse = (header: FrameHeader, code: number): Buffer =>
  withHeader(header, Buffer.from([(header.functionCode | 0x80) & 0xff, code]));

/** Кадр ответа по решению стенда. */
export const replyFrame = (request: ModbusRequest, reply: Reply): Buffer =>
  reply.kind === 'exception'
    ? exceptionResponse(request, reply.code)
    : registersResponse(request, reply.words, reply.garbled);

/** Время передачи по RS-485: 11 бит на символ (старт, 8 бит данных, чётность, стоп). */
export const lineTimeMs = (bytes: number, baud: number): number => (bytes * 11 * 1000) / baud;

/** Байты ответа в линии: без заголовка MBAP, но с CRC. */
export const rtuBytesOf = (frame: Buffer): number => frame.length - MBAP_BYTES + 2;
