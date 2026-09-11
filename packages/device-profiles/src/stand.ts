import { standSchema } from '@fieldstream/contracts';
import type { Stand } from '@fieldstream/contracts';
import type { z } from 'zod';
import { profileByKey, profileForDeviceCode } from './catalog.js';

/** Стенд до применения умолчаний схемы: то, что пишут руками. */
export type StandInput = z.input<typeof standSchema>;

export type StandValidation =
  | { readonly ok: true; readonly stand: Stand }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Значения, встретившиеся в списке больше одного раза. */
const duplicates = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const repeated = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }

  return [...repeated];
};

/** Нарушения ссылок и адресации, которые схемой не выражаются. */
const standIssues = (stand: Stand): string[] => {
  const issues: string[] = [];
  const siteCodes = new Set(stand.sites.map((site) => site.code));
  const gatewayCodes = new Set(stand.gateways.map((gateway) => gateway.code));
  const lineCodes = new Set(stand.lines.map((line) => line.code));

  for (const code of duplicates(stand.sites.map((site) => site.code))) {
    issues.push(`площадка ${code} объявлена дважды`);
  }
  for (const code of duplicates(stand.gateways.map((gateway) => gateway.code))) {
    issues.push(`шлюз ${code} объявлен дважды`);
  }
  for (const code of duplicates(stand.lines.map((line) => line.code))) {
    issues.push(`линия ${code} объявлена дважды: код линии это ключ партиции циклов опроса`);
  }
  for (const code of duplicates(stand.devices.map((device) => device.code))) {
    issues.push(`прибор ${code} объявлен дважды`);
  }
  for (const port of duplicates(stand.lines.map((line) => String(line.port)))) {
    issues.push(`порт ${port} занят двумя линиями: симулятор поднимает все линии на одном хосте`);
  }

  for (const gateway of stand.gateways) {
    if (!siteCodes.has(gateway.siteCode)) {
      issues.push(`шлюз ${gateway.code} ссылается на неизвестную площадку ${gateway.siteCode}`);
    }
  }
  for (const line of stand.lines) {
    if (!gatewayCodes.has(line.gatewayCode)) {
      issues.push(`линия ${line.code} ссылается на неизвестный шлюз ${line.gatewayCode}`);
    }
  }

  for (const device of stand.devices) {
    if (!lineCodes.has(device.lineCode)) {
      issues.push(`прибор ${device.code} ссылается на неизвестную линию ${device.lineCode}`);
    }
    if (profileByKey(device.profileKey) === undefined) {
      issues.push(`прибор ${device.code}: неизвестная модель ${device.profileKey}`);
    }

    const catalogProfile = profileForDeviceCode(device.code);
    if (catalogProfile !== undefined && catalogProfile.profileKey !== device.profileKey) {
      issues.push(
        `прибор ${device.code} по каталогу модели ${catalogProfile.profileKey}, ` +
          `а на стенде указана ${device.profileKey}`,
      );
    }
  }

  const addresses = stand.devices.map((device) => `${device.lineCode}:${String(device.slaveId)}`);
  for (const address of duplicates(addresses)) {
    issues.push(`адрес ${address} занят двумя приборами: на одной линии RS-485 адрес уникален`);
  }

  return issues;
};

/** Полная проверка стенда: схема плюс связность. Ошибок не бросает, возвращает весь список. */
export const validateStand = (input: unknown): StandValidation => {
  const parsed = standSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  }

  const issues = standIssues(parsed.data);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, stand: parsed.data };
};

/** Стенд, проверенный на месте: ошибка описания не доедет до линии. */
export const defineStand = (input: StandInput): Stand => {
  const result = validateStand(input);
  if (result.ok) return result.stand;

  throw new Error(
    `стенд описан неверно:\n${result.issues.map((issue) => `  ${issue}`).join('\n')}`,
  );
};

/**
 * Демо-стенд: две площадки, по шлюзу на каждой, по две линии на шлюз.
 * На каждой линии три камеры и три счётчика на вводах их компрессорных агрегатов.
 * Скорости 19200 и 9600 чередуются, чтобы разница в длительности цикла была видна.
 */
export const DEMO_STAND: Stand = defineStand({
  sites: [
    { code: 'SITE-A', name: 'Site Alpha', timezone: 'Europe/Moscow' },
    { code: 'SITE-B', name: 'Site Bravo', timezone: 'Europe/Moscow' },
  ],
  gateways: [
    { code: 'GW-01', siteCode: 'SITE-A', host: '192.0.2.11' },
    { code: 'GW-02', siteCode: 'SITE-B', host: '192.0.2.12' },
  ],
  lines: [
    { code: 'L1', gatewayCode: 'GW-01', port: 5020, baud: 19200 },
    { code: 'L2', gatewayCode: 'GW-01', port: 5021, baud: 9600 },
    { code: 'L3', gatewayCode: 'GW-02', port: 5022, baud: 19200 },
    { code: 'L4', gatewayCode: 'GW-02', port: 5023, baud: 9600 },
  ],
  devices: [
    { code: 'RC-101', lineCode: 'L1', slaveId: 1, profileKey: 'rc-2000' },
    { code: 'RC-102', lineCode: 'L1', slaveId: 2, profileKey: 'rc-2000' },
    { code: 'RC-103', lineCode: 'L1', slaveId: 3, profileKey: 'rc-2000' },
    { code: 'PM-201', lineCode: 'L1', slaveId: 4, profileKey: 'pm-3phase' },
    { code: 'PM-202', lineCode: 'L1', slaveId: 5, profileKey: 'pm-3phase' },
    { code: 'PM-203', lineCode: 'L1', slaveId: 6, profileKey: 'pm-3phase' },
    { code: 'RC-104', lineCode: 'L2', slaveId: 1, profileKey: 'rc-2000' },
    { code: 'RC-105', lineCode: 'L2', slaveId: 2, profileKey: 'rc-2000' },
    { code: 'RC-106', lineCode: 'L2', slaveId: 3, profileKey: 'rc-2000' },
    { code: 'PM-204', lineCode: 'L2', slaveId: 4, profileKey: 'pm-3phase' },
    { code: 'PM-205', lineCode: 'L2', slaveId: 5, profileKey: 'pm-3phase' },
    { code: 'PM-206', lineCode: 'L2', slaveId: 6, profileKey: 'pm-3phase' },
    { code: 'RC-107', lineCode: 'L3', slaveId: 1, profileKey: 'rc-2000' },
    { code: 'RC-108', lineCode: 'L3', slaveId: 2, profileKey: 'rc-2000' },
    { code: 'RC-109', lineCode: 'L3', slaveId: 3, profileKey: 'rc-2000' },
    { code: 'PM-207', lineCode: 'L3', slaveId: 4, profileKey: 'pm-3phase' },
    { code: 'PM-208', lineCode: 'L3', slaveId: 5, profileKey: 'pm-3phase' },
    { code: 'PM-209', lineCode: 'L3', slaveId: 6, profileKey: 'pm-3phase' },
    { code: 'RC-110', lineCode: 'L4', slaveId: 1, profileKey: 'rc-2000' },
    { code: 'RC-111', lineCode: 'L4', slaveId: 2, profileKey: 'rc-2000' },
    { code: 'RC-112', lineCode: 'L4', slaveId: 3, profileKey: 'rc-2000' },
    { code: 'PM-210', lineCode: 'L4', slaveId: 4, profileKey: 'pm-3phase' },
    { code: 'PM-211', lineCode: 'L4', slaveId: 5, profileKey: 'pm-3phase' },
    { code: 'PM-212', lineCode: 'L4', slaveId: 6, profileKey: 'pm-3phase' },
  ],
});
