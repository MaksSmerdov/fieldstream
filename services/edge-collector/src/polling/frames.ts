import { randomBytes } from 'node:crypto';
import type {
  DeviceProfile,
  ErrorKind,
  PollCycle,
  RawBlock,
  StandDevice,
  TelemetryRaw,
} from '@fieldstream/contracts';
import type { PlanMode } from '@fieldstream/device-profiles';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { BreakerView } from '../breaker/breaker.js';
import type { BackoffStep } from '../transport/backoff.js';

/** Где стоит прибор: всё, что едет в кадр вместе с его регистрами. */
export interface DeviceContext {
  readonly siteCode: string;
  readonly gatewayCode: string;
  readonly lineCode: string;
  readonly device: StandDevice;
  readonly profile: DeviceProfile;
}

/** Факты одного обращения к прибору для события цикла опроса. */
export interface CycleFacts {
  readonly ok: boolean;
  readonly errorKind: ErrorKind | null;
  readonly durationMs: number;
  readonly requestCount: number;
  readonly planMode: PlanMode;
  readonly backoff?: BackoffStep;
  readonly breaker?: { readonly state: BreakerView; readonly nextProbeAt: number | null };
}

/** Сквозной идентификатор обхода: рождается на цикле опроса и едет дальше через все сервисы. */
export const newTraceId = (): string => randomBytes(8).toString('hex');

/** Сырой кадр прибора: слова как пришли с линии и версия профиля, по которой их читали. */
export const buildRawFrame = (
  context: DeviceContext,
  blocks: readonly RawBlock[],
  atMs: number,
  cycleMs: number,
  traceId: string,
): TelemetryRaw => ({
  schema: 'telemetry.raw',
  v: 1,
  ts: toIsoTimestamp(atMs),
  siteCode: context.siteCode,
  gatewayCode: context.gatewayCode,
  lineCode: context.lineCode,
  deviceCode: context.device.code,
  slaveId: context.device.slaveId,
  profileKey: context.profile.profileKey,
  profileVersion: context.profile.version,
  blocks: blocks.map((block) => ({ ...block, words: [...block.words] })),
  cycleMs: Math.max(0, Math.round(cycleMs)),
  traceId,
});

/** Событие цикла опроса. Пишется и при отказе, когда кадра нет: иначе отказ невидим. */
export const buildPollCycle = (
  context: DeviceContext,
  facts: CycleFacts,
  atMs: number,
  traceId: string,
): PollCycle => ({
  schema: 'poll.cycle',
  v: 1,
  ts: toIsoTimestamp(atMs),
  lineCode: context.lineCode,
  deviceCode: context.device.code,
  ok: facts.ok,
  errorKind: facts.errorKind,
  durationMs: Math.max(0, Math.round(facts.durationMs)),
  requestCount: facts.requestCount,
  planMode: facts.planMode,
  ...(facts.backoff === undefined ? {} : { backoff: facts.backoff }),
  ...(facts.breaker === undefined
    ? {}
    : {
        breaker: {
          state: facts.breaker.state,
          nextProbeAt:
            facts.breaker.nextProbeAt === null ? null : toIsoTimestamp(facts.breaker.nextProbeAt),
        },
      }),
  traceId,
});
