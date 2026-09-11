import type { ErrorKind, RawBlock } from '@fieldstream/contracts';
import type { ReadPlan, RegisterSpan } from '@fieldstream/device-profiles';
import type { Clock } from '@fieldstream/domain';
import { classifyError } from '../transport/errors.js';

/** Чтение одного диапазона регистров у прибора. */
export type ReadRegisters = (slaveId: number, span: RegisterSpan) => Promise<number[]>;

/** Итог опроса прибора за один обход. */
export interface DevicePoll {
  readonly ok: boolean;
  readonly blocks: readonly RawBlock[];
  readonly errorKind: ErrorKind | null;
  readonly error: unknown;
  readonly requestCount: number;
  readonly durationMs: number;
}

/**
 * Опрос прибора по плану: блоки подряд, первая ошибка прекращает опрос этого прибора,
 * а линия идёт к следующему. Частичный кадр не публикуется: декодеру нужен весь прибор.
 */
export const pollDevice = async (
  read: ReadRegisters,
  slaveId: number,
  plan: ReadPlan,
  clock: Clock,
): Promise<DevicePoll> => {
  const startedAt = clock.now();
  const blocks: RawBlock[] = [];
  let requestCount = 0;

  for (const block of plan.blocks) {
    requestCount += 1;
    try {
      const words = await read(slaveId, block);
      blocks.push({ registerType: block.registerType, startAddress: block.startAddress, words });
    } catch (error) {
      return {
        ok: false,
        blocks,
        errorKind: classifyError(error),
        error,
        requestCount,
        durationMs: clock.now() - startedAt,
      };
    }
  }

  return {
    ok: true,
    blocks,
    errorKind: null,
    error: null,
    requestCount,
    durationMs: clock.now() - startedAt,
  };
};
