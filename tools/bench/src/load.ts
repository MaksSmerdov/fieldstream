import { setTimeout as delay } from 'node:timers/promises';
import {
  commandAcceptedSchema,
  commandProgressSchema,
  labLinesResponseSchema,
  topologyResponseSchema,
} from '@fieldstream/contracts';
import type { Gateway, LinePoll, Load } from './measure.js';
import { errorText, startTimer } from './report.js';
import { formatDuration } from './stats.js';

/** Сколько ждать, пока сборщик применит команду, и как часто перечитывать её ход. */
const COMMAND_LIMIT_MS = 45_000;
const COMMAND_STEP_MS = 500;

/** Сколько дать конвейеру устояться после смены такта, прежде чем снимать цифры. */
const SETTLE_MS = 10_000;

/** Сколько раз повторять команду и сколько ждать между попытками. */
const TRIES = 3;
const RETRY_MS = 1_000;

/** Стенд не трогали: замеры шли только на чтение. */
export const NO_LOAD: Load = Object.freeze({ on: false, pollIntervalMs: null });

/**
 * Ожидание между шагами: пауза перед повтором команды и время на устаивание конвейера.
 * Отдельным параметром оно нужно затем, чтобы проверка возврата такта не ждала стенд
 * по-настоящему, а signal снимал ожидание при срыве прогона с клавиатуры.
 */
export type Wait = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Обычное ожидание: снимается сигналом срыва, если он передан. */
const realWait: Wait = async (ms, signal) => {
  await delay(ms, undefined, { signal });
};

/** Снимок тактов до смены и откуда он взят: живое состояние сборщика или таблица линий. */
export interface PollsSnapshot {
  readonly polls: readonly LinePoll[];
  readonly source: string;
}

/** Нагрузочный режим и возврат стенда к тому, что было до него. */
export interface LoadHandle {
  readonly load: Load;
  readonly restore: () => Promise<readonly LinePoll[]>;
}

/**
 * Живые такты линий от сборщика: снимки линий едут топиком и лежат в /api/lab/lines. Команда
 * line.set_poll_interval меняет такт только в памяти сборщика, в core.lines он остаётся
 * засеянным, поэтому снимок для возврата снимается отсюда, а не из топологии.
 */
const readLivePolls = async (gateway: Gateway): Promise<LinePoll[] | null> => {
  const reply = await gateway.request('GET', '/api/lab/lines');
  const parsed = labLinesResponseSchema.safeParse(reply.body);
  if (reply.status !== 200 || !parsed.success || parsed.data.lines.length === 0) return null;

  return parsed.data.lines.map((line) => ({
    lineCode: line.lineCode,
    pollIntervalMs: line.pollIntervalMs,
  }));
};

/** Такты линий из топологии: запасной источник, когда снимков сборщика нет. */
const readTopologyPolls = async (gateway: Gateway): Promise<LinePoll[]> => {
  const reply = await gateway.request('GET', '/api/topology');
  const parsed = topologyResponseSchema.safeParse(reply.body);
  if (reply.status !== 200 || !parsed.success) {
    throw new Error(
      `топология не прочитана: шлюз ответил ${reply.status ?? 'молчанием'}` +
        (reply.error === null ? '' : ` (${reply.error})`),
    );
  }

  return parsed.data.sites.flatMap((site) =>
    site.gateways.flatMap((item) =>
      item.lines.map((line) => ({ lineCode: line.code, pollIntervalMs: line.pollIntervalMs })),
    ),
  );
};

/** Снимок тактов до смены: сначала живое состояние сборщика, затем топология. */
export const readPolls = async (gateway: Gateway): Promise<PollsSnapshot> => {
  const live = await readLivePolls(gateway);
  if (live !== null) return { polls: live, source: 'живые снимки линий GET /api/lab/lines' };

  return {
    polls: await readTopologyPolls(gateway),
    source:
      'топология GET /api/topology (снимков линий у шлюза нет): ' +
      'в core.lines стоит засеянный такт, а не тот, что действует у сборщика',
  };
};

/** Ожидание, пока команда дойдёт до сборщика: ход команды виден через GET /api/commands/:id. */
const waitApplied = async (
  gateway: Gateway,
  commandId: string,
  wait: Wait,
  signal?: AbortSignal,
): Promise<string> => {
  const timer = startTimer();

  for (;;) {
    const reply = await gateway.request('GET', `/api/commands/${commandId}`);
    const progress = commandProgressSchema.safeParse(reply.body);

    if (progress.success) {
      const { stage, detail } = progress.data;
      if (stage === 'applied') return detail ?? 'применена';
      if (stage === 'rejected' || stage === 'expired') {
        const word = stage === 'rejected' ? 'отклонена' : 'просрочена';
        throw new Error(`команда ${commandId} ${word}: ${detail ?? 'без объяснения'}`);
      }
    }
    if (timer.ms() >= COMMAND_LIMIT_MS) {
      throw new Error(
        `сборщик не применил команду ${commandId} за ${formatDuration(COMMAND_LIMIT_MS)}`,
      );
    }

    await wait(COMMAND_STEP_MS, signal);
  }
};

/** Отказ шлюза словами: молчание, просроченный токен или всё остальное по коду ответа. */
const replyText = (status: number | null, error: string | null): string =>
  status === null ? `молчанием (${error ?? 'нет ответа'})` : String(status);

/**
 * Одна попытка сменить такт линии. Токен доступа живёт десять минут, а прогон с нагрузкой идёт
 * дольше, поэтому на 401 инструмент входит заново и повторяет команду: иначе возврат прежнего
 * такта упирался бы в просроченный токен, и стенд оставался бы под наведённой нагрузкой.
 */
const trySetPoll = async (
  gateway: Gateway,
  line: LinePoll,
  wait: Wait,
  signal?: AbortSignal,
): Promise<string> => {
  const reply = await gateway.request('POST', '/api/commands', {
    lineCode: line.lineCode,
    kind: 'line.set_poll_interval',
    args: { pollIntervalMs: line.pollIntervalMs },
  });
  const accepted = commandAcceptedSchema.safeParse(reply.body);
  if (reply.status === 401) {
    await gateway.login();
    throw new Error(`токен доступа просрочен, вход повторён: шлюз ответил ${reply.status}`);
  }
  if (reply.status === null || reply.status >= 300 || !accepted.success) {
    throw new Error(
      `такт линии ${line.lineCode} не сменён: шлюз ответил ${replyText(reply.status, reply.error)}`,
    );
  }

  return waitApplied(gateway, accepted.data.commandId, wait, signal);
};

/** Смена такта опроса линии штатной командой стенда, с повторами при отказе шлюза. */
const setPoll = async (
  gateway: Gateway,
  line: LinePoll,
  wait: Wait,
  signal?: AbortSignal,
): Promise<string> => {
  let last: unknown = new Error('попыток не было');

  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    try {
      return await trySetPoll(gateway, line, wait, signal);
    } catch (error) {
      last = error;
      if (attempt < TRIES) await wait(RETRY_MS);
    }
  }

  throw new Error(`${errorText(last)} (попыток ${TRIES})`);
};

/**
 * Нагрузочный режим. Приборов на стенде не прибавляется, топология DEMO_STAND остаётся на своих
 * двадцати четырёх: нагрузка наводится штатной командой line.set_poll_interval, то есть тем же
 * путём, каким её наводит оператор. Прежние такты снимаются живым состоянием сборщика до смены
 * и возвращаются в restore, который вызывается и тогда, когда замер сорвался. Возврат идёт один
 * раз и без сигнала срыва: его ожидания снимать нельзя, иначе стенд останется под нагрузкой.
 */
export const applyLoad = async (params: {
  readonly gateway: Gateway;
  readonly pollIntervalMs: number;
  readonly note: (text: string) => void;
  readonly signal?: AbortSignal;
  readonly wait?: Wait;
}): Promise<LoadHandle> => {
  const wait = params.wait ?? realWait;
  const snapshot = await readPolls(params.gateway);
  params.note(`прежние такты сняты: ${snapshot.source}`);
  const changed = snapshot.polls.filter((line) => line.pollIntervalMs !== params.pollIntervalMs);
  const load: Load = { on: true, pollIntervalMs: params.pollIntervalMs };
  let restored = false;

  const restore = async (): Promise<readonly LinePoll[]> => {
    if (restored) return [];
    restored = true;
    const failed: LinePoll[] = [];

    for (const line of changed) {
      try {
        await setPoll(params.gateway, line, wait);
        params.note(`такт линии ${line.lineCode} возвращён к ${line.pollIntervalMs} мс`);
      } catch (error) {
        failed.push(line);
        params.note(
          `такт линии ${line.lineCode} не вернулся к ${line.pollIntervalMs} мс: ${errorText(error)}. ` +
            'Прежний такт восстанавливается командой line.set_poll_interval вручную.',
        );
      }
    }

    return failed;
  };

  if (changed.length === 0) {
    params.note(`такт ${params.pollIntervalMs} мс уже стоит на всех линиях, менять нечего`);
    return { load, restore };
  }

  try {
    for (const line of changed) {
      const detail = await setPoll(
        params.gateway,
        { lineCode: line.lineCode, pollIntervalMs: params.pollIntervalMs },
        wait,
        params.signal,
      );
      params.note(
        `такт линии ${line.lineCode} сменён с ${line.pollIntervalMs} на ${params.pollIntervalMs} мс: ${detail}`,
      );
    }
  } catch (error) {
    await restore();
    throw new Error(`нагрузочный режим не включился: ${errorText(error)}`);
  }

  params.note(`конвейер устаивается ${formatDuration(SETTLE_MS)} после смены такта`);
  await wait(SETTLE_MS, params.signal);

  return { load, restore };
};
