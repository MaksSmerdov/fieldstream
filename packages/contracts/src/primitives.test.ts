import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  deviceCodeSchema,
  gatewayCodeSchema,
  isoTimestampSchema,
  lineCodeSchema,
  siteCodeSchema,
  slaveIdSchema,
  traceIdSchema,
} from './primitives.js';

/** Значения, которые схема неожиданно отвергла. */
const failing = (schema: z.ZodTypeAny, values: readonly unknown[]): unknown[] =>
  values.filter((value) => !schema.safeParse(value).success);

/** Значения, которые схема неожиданно пропустила. */
const passing = (schema: z.ZodTypeAny, values: readonly unknown[]): unknown[] =>
  values.filter((value) => schema.safeParse(value).success);

describe('коды объектов', () => {
  it('принимают ровно объявленный вид', () => {
    expect(failing(siteCodeSchema, ['SITE-A', 'SITE-Z'])).toEqual([]);
    expect(failing(gatewayCodeSchema, ['GW-01', 'GW-99'])).toEqual([]);
    expect(failing(lineCodeSchema, ['L1', 'L9'])).toEqual([]);
    expect(failing(deviceCodeSchema, ['RC-101', 'PM-201'])).toEqual([]);
  });

  it('отвергают всё, что сломало бы ключ партиции', () => {
    expect(passing(siteCodeSchema, ['site-a', 'SITE-AB', 'SITE-', 'A'])).toEqual([]);
    expect(passing(gatewayCodeSchema, ['GW-1', 'GW-001', 'gw-01', 'GW01'])).toEqual([]);
    expect(passing(lineCodeSchema, ['L12', 'l1', 'LINE-1', 'L'])).toEqual([]);
    expect(passing(deviceCodeSchema, ['rc-101', 'RC-1011', 'R-101', 'RC101', ' RC-101'])).toEqual(
      [],
    );
  });
});

describe('метка времени', () => {
  it('принимает только момент с зоной', () => {
    expect(
      failing(isoTimestampSchema, ['2026-09-11T10:00:00Z', '2026-09-11T13:00:00+03:00']),
    ).toEqual([]);
    expect(
      passing(isoTimestampSchema, ['2026-09-11T10:00:00', '2026-09-11', '11.09.2026']),
    ).toEqual([]);
  });
});

describe('адрес и трасса', () => {
  it('адрес прибора держится в границах Modbus', () => {
    expect(failing(slaveIdSchema, [1, 247])).toEqual([]);
    expect(passing(slaveIdSchema, [0, 248, 1.5, -1])).toEqual([]);
  });

  it('идентификатор трассы не короче восьми символов', () => {
    expect(failing(traceIdSchema, ['0123456789abcdef'])).toEqual([]);
    expect(passing(traceIdSchema, ['short', ''])).toEqual([]);
  });
});
