import { z } from 'zod';
import {
  deviceCodeSchema,
  gatewayCodeSchema,
  lineCodeSchema,
  siteCodeSchema,
  slaveIdSchema,
} from '../primitives.js';

export const standSiteSchema = z
  .object({
    code: siteCodeSchema,
    name: z.string().min(1),
    /** Часовой пояс площадки: от него зависит суточная кривая нагрузки. */
    timezone: z.string().min(1),
  })
  .strict();
export type StandSite = z.infer<typeof standSiteSchema>;

export const standGatewaySchema = z
  .object({
    code: gatewayCodeSchema,
    siteCode: siteCodeSchema,
    host: z.string().min(1),
  })
  .strict();
export type StandGateway = z.infer<typeof standGatewaySchema>;

/**
 * Линия RS-485 за шлюзом. У шлюза на каждый последовательный порт свой TCP-порт,
 * поэтому линия адресуется парой: адрес шлюза и порт линии.
 */
export const standLineSchema = z
  .object({
    code: lineCodeSchema,
    gatewayCode: gatewayCodeSchema,
    port: z.number().int().min(1).max(65535),
    baud: z.number().int().min(1200).max(115200),
    pollIntervalMs: z.number().int().min(1000).default(10_000),
    requestTimeoutMs: z.number().int().min(50).default(600),
  })
  .strict();
export type StandLine = z.infer<typeof standLineSchema>;

export const standDeviceSchema = z
  .object({
    code: deviceCodeSchema,
    lineCode: lineCodeSchema,
    slaveId: slaveIdSchema,
    profileKey: z.string().min(1),
  })
  .strict();
export type StandDevice = z.infer<typeof standDeviceSchema>;

/** Стенд целиком: площадки, шлюзы, линии и приборы на них. */
export const standSchema = z
  .object({
    sites: z.array(standSiteSchema).min(1),
    gateways: z.array(standGatewaySchema).min(1),
    lines: z.array(standLineSchema).min(1),
    devices: z.array(standDeviceSchema).min(1),
  })
  .strict();
export type Stand = z.infer<typeof standSchema>;
