import { createHash } from 'node:crypto';
import type { DeviceMode } from '@fieldstream/contracts';
import { toIsoTimestamp } from './clock.js';

/** Пространство имён идентификаторов алармов. Постоянное: от него зависит повторяемость реплея. */
const ALARM_NAMESPACE = '2f8a5b1e-6c0d-4a7f-9b3c-5d1e8a4f7c02';

export interface AlarmEpisode {
  readonly deviceCode: string;
  readonly metricKey: string;
  readonly mode: DeviceMode;
  readonly raisedAt: number;
}

/**
 * Ключ эпизода: подъём и снятие одного аларма дают одинаковый ключ, поэтому эпизод
 * остаётся одной строкой, а повторно доставленная пачка гасится уникальным индексом.
 * Время берётся из кадра, а не из часов: иначе повтор дал бы новый ключ.
 */
export const alarmDedupeKey = (episode: AlarmEpisode): string =>
  `${episode.deviceCode}|${episode.metricKey}|${episode.mode}|${toIsoTimestamp(episode.raisedAt)}`;

/** Идентификатор по имени (UUID версии 5): те же входные данные всегда дают тот же идентификатор. */
const uuidFromName = (namespace: string, name: string): string => {
  const digest = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
};

/**
 * Идентификатор аларма считается из ключа эпизода, база его не выдаёт. Прогнанная заново
 * история даёт те же идентификаторы, и записи реплея сравнимы с боевыми.
 */
export const alarmIdOf = (dedupeKey: string): string => uuidFromName(ALARM_NAMESPACE, dedupeKey);
