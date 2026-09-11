import { describe, expect, it } from 'vitest';
import { DEMO_STAND, validateStand } from './stand.js';
import type { StandInput } from './stand.js';
import { PM3PHASE_DEVICE_CODES } from './profiles/pm-3phase.js';
import { RC2000_DEVICE_CODES } from './profiles/rc-2000.js';

/** Минимальный корректный стенд: от него строятся все испорченные варианты. */
const validInput = (): StandInput => ({
  sites: [{ code: 'SITE-A', name: 'Site Alpha', timezone: 'UTC' }],
  gateways: [{ code: 'GW-01', siteCode: 'SITE-A', host: '192.0.2.11' }],
  lines: [
    { code: 'L1', gatewayCode: 'GW-01', port: 5020, baud: 19200 },
    { code: 'L2', gatewayCode: 'GW-01', port: 5021, baud: 9600 },
  ],
  devices: [
    { code: 'RC-101', lineCode: 'L1', slaveId: 1, profileKey: 'rc-2000' },
    { code: 'PM-201', lineCode: 'L2', slaveId: 1, profileKey: 'pm-3phase' },
  ],
});

const issuesOf = (input: unknown): readonly string[] => {
  const result = validateStand(input);
  return result.ok ? [] : result.issues;
};

describe('DEMO_STAND', () => {
  it('24 прибора на 4 линиях за 2 шлюзами на 2 площадках', () => {
    expect(DEMO_STAND.sites).toHaveLength(2);
    expect(DEMO_STAND.gateways).toHaveLength(2);
    expect(DEMO_STAND.lines).toHaveLength(4);
    expect(DEMO_STAND.devices).toHaveLength(24);
  });

  it('каждый прибор каталога стоит на стенде ровно один раз', () => {
    const catalog = [...RC2000_DEVICE_CODES, ...PM3PHASE_DEVICE_CODES].sort();
    const onStand = DEMO_STAND.devices.map((device) => device.code).sort();

    expect(onStand).toEqual(catalog);
  });

  it('на каждой линии три камеры и три счётчика', () => {
    for (const line of DEMO_STAND.lines) {
      const devices = DEMO_STAND.devices.filter((device) => device.lineCode === line.code);

      expect(devices.filter((device) => device.profileKey === 'rc-2000')).toHaveLength(3);
      expect(devices.filter((device) => device.profileKey === 'pm-3phase')).toHaveLength(3);
    }
  });

  it('умолчания схемы применены: опрос раз в 10 секунд, таймаут 600 мс', () => {
    for (const line of DEMO_STAND.lines) {
      expect(line.pollIntervalMs).toBe(10_000);
      expect(line.requestTimeoutMs).toBe(600);
    }
  });
});

describe('validateStand', () => {
  it('корректный стенд проходит', () => {
    expect(issuesOf(validInput())).toEqual([]);
  });

  it('находит занятый адрес на линии', () => {
    const input = validInput();
    input.devices.push({ code: 'RC-102', lineCode: 'L1', slaveId: 1, profileKey: 'rc-2000' });

    expect(issuesOf(input)).toEqual([
      'адрес L1:1 занят двумя приборами: на одной линии RS-485 адрес уникален',
    ]);
  });

  it('находит ссылки в пустоту', () => {
    const input = validInput();
    input.gateways.push({ code: 'GW-02', siteCode: 'SITE-B', host: '192.0.2.12' });
    input.lines.push({ code: 'L3', gatewayCode: 'GW-09', port: 5022, baud: 9600 });
    input.devices.push({ code: 'RC-102', lineCode: 'L7', slaveId: 1, profileKey: 'rc-2000' });

    expect(issuesOf(input)).toEqual([
      'шлюз GW-02 ссылается на неизвестную площадку SITE-B',
      'линия L3 ссылается на неизвестный шлюз GW-09',
      'прибор RC-102 ссылается на неизвестную линию L7',
    ]);
  });

  it('находит неизвестную модель и расхождение с каталогом', () => {
    const input = validInput();
    input.devices.push({ code: 'XX-900', lineCode: 'L1', slaveId: 2, profileKey: 'nope' });
    input.devices.push({ code: 'RC-102', lineCode: 'L1', slaveId: 3, profileKey: 'pm-3phase' });

    expect(issuesOf(input)).toEqual([
      'прибор XX-900: неизвестная модель nope',
      'прибор RC-102 по каталогу модели rc-2000, а на стенде указана pm-3phase',
    ]);
  });

  it('находит общий порт и повтор кода линии', () => {
    const input = validInput();
    input.lines.push({ code: 'L2', gatewayCode: 'GW-01', port: 5020, baud: 9600 });

    expect(issuesOf(input)).toEqual([
      'линия L2 объявлена дважды: код линии это ключ партиции циклов опроса',
      'порт 5020 занят двумя линиями: симулятор поднимает все линии на одном хосте',
    ]);
  });

  it('ошибка схемы возвращается с путём до поля', () => {
    const input = validInput();
    input.lines[0] = { code: 'Line-1', gatewayCode: 'GW-01', port: 5020, baud: 19200 };

    expect(issuesOf(input)).toEqual(['lines.0.code: ожидается вид L1']);
  });
});
