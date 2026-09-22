import { performance } from 'node:perf_hooks';
import type { EachBatchPayload, IHeaders, KafkaMessage, Producer } from 'kafkajs';
import type { Experiment, Lab } from '../experiment.js';
import { errorText } from '../lab.js';

/** Заголовки диагностики: имена те же, что у KAFKA_HEADERS в манифесте топиков. */
const HEADER = {
  schemaVersion: 'x-schema-version',
  originTopic: 'x-dlq-origin-topic',
  originPartition: 'x-dlq-origin-partition',
  originOffset: 'x-dlq-origin-offset',
  originTimestamp: 'x-dlq-origin-timestamp',
  errorClass: 'x-dlq-error-class',
  error: 'x-dlq-error',
  attempt: 'x-dlq-attempt',
  firstFailedAt: 'x-dlq-first-failed-at',
  consumerGroup: 'x-dlq-consumer-group',
  redriveOf: 'x-dlq-redrive-of',
} as const;

/** С какой по счёту неудачи сообщение больше не подаётся: FINAL_ATTEMPTS процессора. */
const FINAL_ATTEMPTS = 3;

/** Мажорная версия схемы, которую понимает потребитель: как .v1 в имени боевого топика. */
const TOPIC_MAJOR = 1;

/** Сколько строк очереди берёт один запрос повторной подачи. */
const REDRIVE_LIMIT = 500;

/** Боевые топики стенда: читаются только концы партиций, ни записи, ни групп. */
const LIVE_RAW_TOPIC = 'fieldstream.telemetry.raw.v1';
const LIVE_DLQ_TOPIC = 'fieldstream.telemetry.raw.dlq.v1';

/** Приборы, которые знает топология опыта. PM-207 добавляется по ходу. */
const KNOWN_DEVICES = ['RC-101', 'RC-102', 'RC-103', 'RC-104', 'RC-105'];
const LATE_DEVICE = 'PM-207';

const DEVICE_CODE = /^[A-Z]{2}-\d{3}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ATTEMPT_PATTERN = /^[1-9]\d{0,3}$/;
const ROW_ID_PATTERN = /^[1-9]\d*$/;

/** Сырой кадр: укороченная копия telemetryRawSchema с полями, которые проверяет опыт. */
interface Frame {
  readonly schema: 'telemetry.raw';
  readonly v: 1;
  readonly ts: string;
  readonly deviceCode: string;
  readonly profileKey: string;
  readonly profileVersion: number;
  readonly blocks: readonly {
    readonly registerType: string;
    readonly startAddress: number;
    readonly words: readonly number[];
  }[];
  readonly traceId: string;
}

type Failure = 'empty' | 'invalid_json' | 'schema' | 'schema_major_mismatch' | 'unknown_device';

type Decoded =
  | { readonly ok: true; readonly frame: Frame }
  | { readonly ok: false; readonly errorClass: Failure; readonly error: string };

/** Строка таблицы core.dlq_message в памяти опыта: те же колонки и те же правила. */
interface DlqRow {
  readonly id: number;
  readonly sourceTopic: string;
  readonly partition: number;
  readonly offset: string;
  readonly key: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: Buffer | null;
  readonly error: { readonly class: Failure; readonly message: string };
  readonly attempts: number;
  readonly firstSeen: string;
  readonly redriveOf: number | null;
  resolvedAt: string | null;
  finalRejected: boolean;
}

/** Копия строки очереди, дошедшая до потребителя. */
interface DlqCopy {
  readonly id: number;
  readonly sourceTopic: string;
  readonly key: string | null;
}

/** Что заголовки рассказали о прошлых неудачах сообщения. */
interface History {
  readonly attempts: number;
  readonly firstFailedAt: string | null;
  readonly redriveOf: number | null;
}

/** Сообщение с сырыми байтами: для очереди недоставленных и для повторной подачи. */
interface RawMessage {
  readonly key: Buffer | null;
  readonly value: Buffer | null;
  readonly headers: Readonly<Record<string, string>>;
}

/** Одно сообщение, прошедшее через потребителя: чем кончился его разбор. */
interface Pass {
  readonly key: string | null;
  readonly partition: number;
  readonly offset: string;
  readonly attempt: number;
  readonly redriveOf: number | null;
  readonly errorClass: Failure | null;
}

/** Не разобранное сообщение вместе с причиной и историей. */
interface Poisoned {
  readonly message: KafkaMessage;
  readonly history: History;
  readonly errorClass: Failure;
  readonly error: string;
}

/** Что отправляется в учебный топик сырых кадров. */
interface Outgoing {
  readonly key: string;
  readonly value: Buffer | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly what: string;
}

/** Часы опыта: настенное время от начала процесса, без обращения к часам напрямую. */
const nowIso = (): string => new Date(performance.timeOrigin + performance.now()).toISOString();

/** Значение заголовка строкой. */
const headerText = (headers: IHeaders | undefined, name: string): string | null => {
  const raw = headers?.[name];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === undefined) return null;

  return typeof first === 'string' ? first : first.toString('utf8');
};

/** Заголовки сообщения строками, без повторов значения. */
const textHeaders = (headers: IHeaders | undefined): Record<string, string> => {
  const flat: Record<string, string> = {};
  for (const name of Object.keys(headers ?? {})) {
    const value = headerText(headers, name);
    if (value !== null) flat[name] = value;
  }

  return flat;
};

/** Проверка кадра: укороченный повтор telemetryRawSchema, причины в виде «поле: что не так». */
const frameIssues = (json: unknown): string[] => {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return ['корень: ожидается объект'];
  }
  const raw = json as Record<string, unknown>;
  const issues: string[] = [];

  if (raw.schema !== 'telemetry.raw') issues.push('schema: ожидается telemetry.raw');
  if (raw.v !== 1) issues.push('v: ожидается 1');
  if (typeof raw.ts !== 'string' || !ISO_TIME.test(raw.ts)) {
    issues.push('ts: ожидается время ISO 8601 со смещением');
  }
  if (typeof raw.deviceCode !== 'string' || !DEVICE_CODE.test(raw.deviceCode)) {
    issues.push('deviceCode: ожидается вид RC-101 или PM-201');
  }
  if (typeof raw.profileKey !== 'string' || raw.profileKey === '') {
    issues.push('profileKey: ожидается непустая строка');
  }
  if (!Number.isInteger(raw.profileVersion)) issues.push('profileVersion: ожидается целое число');
  if (!Array.isArray(raw.blocks) || raw.blocks.length === 0) {
    issues.push('blocks: ожидается непустой список блоков');
  }
  if (typeof raw.traceId !== 'string' || raw.traceId.length < 8) {
    issues.push('traceId: ожидается строка не короче восьми знаков');
  }

  return issues;
};

/** Разбор входящего сообщения: та же лестница, что у decodeMessage и processFrame приёмника. */
const decode = (message: KafkaMessage, devices: ReadonlySet<string>): Decoded => {
  const version = headerText(message.headers, HEADER.schemaVersion);
  if (version !== null && Number(version) > TOPIC_MAJOR) {
    return {
      ok: false,
      errorClass: 'schema_major_mismatch',
      error: `версия схемы ${version} новее той, что понимает потребитель`,
    };
  }
  if (message.value === null) return { ok: false, errorClass: 'empty', error: 'пустое значение' };

  let json: unknown;
  try {
    json = JSON.parse(message.value.toString('utf8'));
  } catch (error) {
    return { ok: false, errorClass: 'invalid_json', error: errorText(error) };
  }

  const issues = frameIssues(json);
  if (issues.length > 0) return { ok: false, errorClass: 'schema', error: issues.join('; ') };

  const frame = json as Frame;
  if (!devices.has(frame.deviceCode)) {
    return {
      ok: false,
      errorClass: 'unknown_device',
      error: `прибора ${frame.deviceCode} нет в топологии`,
    };
  }

  return { ok: true, frame };
};

/** История неудач из заголовков: испорченный заголовок считается отсутствующим, как readDlqHistory. */
const readHistory = (headers: IHeaders | undefined): History => {
  const attempt = headerText(headers, HEADER.attempt);
  const redriveOf = headerText(headers, HEADER.redriveOf);

  return {
    attempts: attempt !== null && ATTEMPT_PATTERN.test(attempt) ? Number(attempt) : 0,
    firstFailedAt: headerText(headers, HEADER.firstFailedAt),
    redriveOf: redriveOf !== null && ROW_ID_PATTERN.test(redriveOf) ? Number(redriveOf) : null,
  };
};

/** Сообщение очереди: исходные байты и ключ без разбора, диагностика в заголовках (toDlqMessage). */
const toDlqMessage = (
  poisoned: Poisoned,
  origin: { readonly topic: string; readonly partition: number },
  failure: { readonly attempt: number; readonly firstFailedAt: string; readonly group: string },
): RawMessage => ({
  key: poisoned.message.key,
  value: poisoned.message.value,
  headers: {
    ...textHeaders(poisoned.message.headers),
    [HEADER.originTopic]: origin.topic,
    [HEADER.originPartition]: String(origin.partition),
    [HEADER.originOffset]: poisoned.message.offset,
    [HEADER.originTimestamp]: poisoned.message.timestamp,
    [HEADER.errorClass]: poisoned.errorClass,
    [HEADER.error]: poisoned.error.slice(0, 1_000),
    [HEADER.attempt]: String(failure.attempt),
    [HEADER.firstFailedAt]: failure.firstFailedAt,
    [HEADER.consumerGroup]: failure.group,
  },
});

/** Сообщение повторной подачи: исходный ключ и байты, в заголовках счёт попыток и номер строки. */
const toRedriveMessage = (row: DlqRow): RawMessage => ({
  key: row.key === null ? null : Buffer.from(row.key, 'utf8'),
  value: row.payload,
  headers: {
    ...row.headers,
    [HEADER.attempt]: String(row.attempts),
    [HEADER.firstFailedAt]: row.firstSeen,
    [HEADER.redriveOf]: String(row.id),
  },
});

/** Отправка сырых сообщений с подтверждением от всех реплик: как sendRawMessages. */
const sendRaw = async (
  producer: Producer,
  topic: string,
  messages: readonly RawMessage[],
): Promise<void> => {
  if (messages.length === 0) return;

  await producer.send({
    topic,
    acks: -1,
    messages: messages.map((item) => ({
      key: item.key,
      value: item.value,
      headers: { ...item.headers },
    })),
  });
};

/** Запись строки очереди: повтор того же смещения новой строки не даёт, как ON CONFLICT DO NOTHING. */
const recordDlq = (
  table: DlqRow[],
  row: Omit<DlqRow, 'id' | 'resolvedAt' | 'finalRejected'>,
): void => {
  const twin = table.find(
    (item) =>
      item.sourceTopic === row.sourceTopic &&
      item.partition === row.partition &&
      item.offset === row.offset,
  );
  if (twin !== undefined) return;

  const origin = table.find(
    (item) =>
      item.id === row.redriveOf && item.sourceTopic === row.sourceTopic && item.key === row.key,
  );
  table.push({
    ...row,
    id: table.length + 1,
    redriveOf: origin?.id ?? null,
    resolvedAt: null,
    finalRejected: false,
  });
};

/** Ждущие разбора строки, старые первыми: как selectDlqForRedrive. */
const pendingRows = (table: readonly DlqRow[], limit: number): DlqRow[] =>
  table.filter((row) => row.resolvedAt === null && !row.finalRejected).slice(0, limit);

/** Копии закрывают свои строки, если топик и ключ совпали: как resolveDlqCopies. Сколько закрыли. */
const resolveCopies = (
  table: readonly DlqRow[],
  copies: readonly DlqCopy[],
  at: string,
): number => {
  let closed = 0;
  for (const copy of copies) {
    const row = table.find(
      (item) =>
        item.id === copy.id && item.sourceTopic === copy.sourceTopic && item.key === copy.key,
    );
    if (row === undefined || row.resolvedAt !== null || row.finalRejected) continue;
    row.resolvedAt = at;
    closed += 1;
  }

  return closed;
};

/** Виды отказов с числом сообщений, строкой для протокола. */
const classCounts = (passes: readonly Pass[]): string => {
  const counts = new Map<string, number>();
  for (const pass of passes) {
    if (pass.errorClass === null) continue;
    counts.set(pass.errorClass, (counts.get(pass.errorClass) ?? 0) + 1);
  }

  return [...counts].map(([name, count]) => `${name} ${count}`).join(', ');
};

/** Сколько копий легло в ту же партицию, что и первый приход кадра с тем же ключом. */
const samePartition = (passes: readonly Pass[], from: number): number => {
  let same = 0;
  for (const pass of passes.slice(from)) {
    const origin = passes.find((item) => item.attempt === 1 && item.key === pass.key);
    if (origin !== undefined && origin.partition === pass.partition) same += 1;
  }

  return same;
};

/** Совпадение байтов: пустое значение совпадает только с пустым. */
const sameValue = (left: Buffer | null | undefined, right: Buffer | null): boolean => {
  if (left === undefined) return false;
  if (left === null || right === null) return left === right;

  return left.equals(right);
};

/** Байты кадра. */
const bytes = (payload: unknown): Buffer => Buffer.from(JSON.stringify(payload), 'utf8');

/** Правильный сырой кадр прибора. */
const frameOf = (deviceCode: string, atMs: number): Frame => ({
  schema: 'telemetry.raw',
  v: 1,
  ts: new Date(atMs).toISOString(),
  deviceCode,
  profileKey: 'chamber.basic',
  profileVersion: 3,
  blocks: [{ registerType: 'holding', startAddress: 0, words: [2201, 41, 1] }],
  traceId: `lab-dlq-${deviceCode}`,
});

/** Семь кадров: два разбираемых и пять испорченных, каждый своим способом. */
const outgoingFrames = (atMs: number): Outgoing[] => {
  const good = frameOf('RC-101', atMs);
  const cut = bytes(frameOf('RC-102', atMs)).subarray(0, 48);
  const broken = { ...good, deviceCode: 'rc-103', blocks: [] };
  const next = { ...good, ts: new Date(atMs + 1_000).toISOString() };

  return [
    { key: 'RC-101', value: bytes(good), headers: {}, what: 'правильный кадр' },
    { key: 'RC-102', value: cut, headers: {}, what: 'запись оборвалась на середине, это не JSON' },
    {
      key: 'RC-103',
      value: bytes(broken),
      headers: {},
      what: 'JSON не по схеме: код прибора строчными и пустой список блоков',
    },
    { key: 'RC-104', value: null, headers: {}, what: 'пустое значение' },
    {
      key: 'RC-105',
      value: bytes(frameOf('RC-105', atMs)),
      headers: { [HEADER.schemaVersion]: '2' },
      what: 'версия схемы 2 новее той, что понимает потребитель',
    },
    {
      key: LATE_DEVICE,
      value: bytes(frameOf(LATE_DEVICE, atMs)),
      headers: {},
      what: `кадр прибора ${LATE_DEVICE}, которого нет в топологии`,
    },
    {
      key: 'RC-101',
      value: bytes(next),
      headers: {},
      what: 'правильный кадр того же прибора следом за испорченными',
    },
  ];
};

/** Отставание группы: сумма разниц между концом партиции и подтверждённым смещением. */
const groupLag = async (lab: Lab, topic: string, groupId: string): Promise<number> => {
  const ends = await lab.admin.fetchTopicOffsets(topic);
  const committed = await lab.admin.fetchOffsets({ groupId, topics: [topic] });
  const byPartition = new Map(
    (committed[0]?.partitions ?? []).map((item) => [item.partition, item.offset]),
  );

  return ends.reduce((sum, end) => {
    const at = byPartition.get(end.partition) ?? '-1';
    const from = BigInt(at) < 0n ? BigInt(end.low) : BigInt(at);
    return sum + Number(BigInt(end.high) - from);
  }, 0);
};

/** Сколько сообщений лежит в топике сейчас. Топика у брокера нет: null. */
const topicCount = async (lab: Lab, topic: string): Promise<number | null> => {
  if (!(await lab.admin.listTopics()).includes(topic)) return null;
  const ends = await lab.admin.fetchTopicOffsets(topic);

  return ends.reduce((sum, end) => sum + Number(BigInt(end.high) - BigInt(end.low)), 0);
};

/** Число сообщений топика для протокола. */
const countText = (count: number | null): string =>
  count === null ? 'топика у брокера нет' : `${count} сообщений`;

/** Опыт: очередь недоставленных и повторная подача. */
export const dlq: Experiment = {
  name: 'dlq',
  title: 'очередь недоставленных и повторная подача',
  run: async (lab) => {
    const rawTopic = await lab.topic('raw', { partitions: 3 });
    const dlqTopic = await lab.topic('raw.dlq');
    const ingestGroup = lab.groupId('ingest');
    const devices = new Set(KNOWN_DEVICES);
    const table: DlqRow[] = [];
    const traffic: Pass[] = [];
    const queued: RawMessage[] = [];
    let closedByCopy = 0;
    let crash: string | null = null;

    lab.step('Ставлю учебные топики и потребителя с разбором приёмника кадров');
    lab.note(`сырые кадры: ${rawTopic}, партиций 3`);
    lab.note(`очередь недоставленных: ${dlqTopic}, партиция 1`);
    lab.note(`группа потребителя: ${ingestGroup}`);
    lab.note(`топология опыта знает приборы: ${KNOWN_DEVICES.join(', ')}`);

    const producer = await lab.producer();
    const consumer = await lab.consumer('ingest');
    const watcher = await lab.consumer('queue-watch');

    /** Пачка идёт порядком приёмника: разбор, строки очереди, отправка в очередь, подтверждение. */
    const handleBatch = async (payload: EachBatchPayload): Promise<void> => {
      const { batch } = payload;
      const poisoned: Poisoned[] = [];
      const copies: DlqCopy[] = [];
      let lastOffset: string | null = null;

      for (const message of batch.messages) {
        if (!payload.isRunning() || payload.isStale()) break;
        lastOffset = message.offset;
        const history = readHistory(message.headers);
        const key = message.key === null ? null : message.key.toString('utf8');
        if (history.redriveOf !== null) {
          copies.push({ id: history.redriveOf, sourceTopic: batch.topic, key });
        }

        const decoded = decode(message, devices);
        traffic.push({
          key,
          partition: batch.partition,
          offset: message.offset,
          attempt: history.attempts + 1,
          redriveOf: history.redriveOf,
          errorClass: decoded.ok ? null : decoded.errorClass,
        });
        if (!decoded.ok) {
          poisoned.push({ message, history, errorClass: decoded.errorClass, error: decoded.error });
        }
      }

      if (lastOffset === null) return;

      const handledAt = nowIso();
      const failures = poisoned.map((item) => ({
        item,
        attempt: item.history.attempts + 1,
        firstFailedAt: item.history.firstFailedAt ?? handledAt,
      }));

      for (const failure of failures) {
        const message = failure.item.message;
        recordDlq(table, {
          sourceTopic: batch.topic,
          partition: batch.partition,
          offset: message.offset,
          key: message.key === null ? null : message.key.toString('utf8'),
          headers: textHeaders(message.headers),
          payload: message.value,
          error: { class: failure.item.errorClass, message: failure.item.error },
          attempts: failure.attempt,
          firstSeen: failure.firstFailedAt,
          redriveOf: failure.item.history.redriveOf,
        });
      }
      closedByCopy += resolveCopies(table, copies, handledAt);

      await sendRaw(
        producer,
        dlqTopic,
        failures.map((failure) =>
          toDlqMessage(
            failure.item,
            { topic: batch.topic, partition: batch.partition },
            { attempt: failure.attempt, firstFailedAt: failure.firstFailedAt, group: ingestGroup },
          ),
        ),
      );

      payload.resolveOffset(lastOffset);
      await payload.commitOffsetsIfNecessary({
        topics: [
          {
            topic: batch.topic,
            partitions: [
              { partition: batch.partition, offset: (BigInt(lastOffset) + 1n).toString() },
            ],
          },
        ],
      });
      await payload.heartbeat();
    };

    await consumer.subscribe({ topic: rawTopic, fromBeginning: true });
    await consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: async (payload) => {
        try {
          await handleBatch(payload);
        } catch (error) {
          crash = errorText(error);
        }
      },
    });
    await watcher.subscribe({ topic: dlqTopic, fromBeginning: true });
    await watcher.run({
      eachMessage: ({ message }) => {
        queued.push({
          key: message.key,
          value: message.value,
          headers: textHeaders(message.headers),
        });
        return Promise.resolve();
      },
    });

    /** Ожидание: столько сообщений прошло через потребителя. Его отказ поднимается наружу. */
    const passed = (count: number) => (): boolean => {
      if (crash !== null) throw new Error(`потребитель отказал: ${crash}`);
      return traffic.length >= count;
    };

    /**
     * Один запрос повторной подачи, как execute у процессора: исчерпавшие попытки помечаются
     * окончательно отвергнутыми, остальные уходят в исходный топик и считаются разобранными.
     */
    const redrive = async (): Promise<{ redriven: number; rejected: number }> => {
      const rows = pendingRows(table, REDRIVE_LIMIT);
      const rejected = rows.filter((row) => row.attempts >= FINAL_ATTEMPTS);
      const due = rows.filter((row) => row.attempts < FINAL_ATTEMPTS);

      for (const row of rejected) row.finalRejected = true;
      await sendRaw(producer, rawTopic, due.map(toRedriveMessage));
      const at = nowIso();
      for (const row of due) row.resolvedAt = at;

      return { redriven: due.length, rejected: rejected.length };
    };

    lab.step('Отправляю семь кадров: два разбираемых и пять испорченных, каждый своим способом');
    const frames = outgoingFrames(performance.timeOrigin + performance.now());
    for (const item of frames) lab.note(`${item.key}: ${item.what}`);
    await producer.send({
      topic: rawTopic,
      acks: -1,
      messages: frames.map((item) => ({
        key: item.key,
        value: item.value,
        headers: { ...item.headers },
      })),
    });
    lab.observe(`отправлено ${frames.length} сообщений, ключ каждого это код прибора`);

    lab.step('Веду их разбором приёмника: пустое, не JSON, не по схеме, версия новее, нет прибора');
    const reading = lab.timer();
    await lab.waitFor('потребитель разобрал первые кадры', passed(frames.length), {
      limitMs: 60_000,
    });
    const accepted = traffic.filter((pass) => pass.errorClass === null);
    lab.observe(
      `подписка и разбор ${traffic.length} сообщений заняли ${reading.text()}: принято ${accepted.length}, не разобралось ${traffic.length - accepted.length}`,
    );
    lab.observe(`виды отказов: ${classCounts(traffic)}`);
    for (const row of table) {
      lab.note(`${row.key ?? 'без ключа'}: ${row.error.class}, ${row.error.message}`);
    }
    lab.observe(
      `поток не встал: отставание группы ${await groupLag(lab, rawTopic, ingestGroup)}, правильный кадр RC-101 следом за испорченными принят`,
    );

    lab.step('Смотрю, что легло в очередь недоставленных');
    await lab.waitFor(
      'очередь недоставленных получила испорченные кадры',
      () => queued.length >= table.length,
    );
    const sentBytes = new Map(frames.map((item) => [item.key, item.value]));
    let sameBytes = 0;
    let sameKeys = 0;
    for (const item of queued) {
      const key = item.key === null ? null : item.key.toString('utf8');
      if (key !== null && sentBytes.has(key)) sameKeys += 1;
      if (sameValue(key === null ? undefined : sentBytes.get(key), item.value)) sameBytes += 1;
      const size = item.value === null ? 'значение пустое' : `${item.value.length} байт`;
      lab.note(
        `${key ?? 'без ключа'}: ${item.headers[HEADER.errorClass] ?? '?'}, ${size}, исходник партиция ${item.headers[HEADER.originPartition] ?? '?'} смещение ${item.headers[HEADER.originOffset] ?? '?'}, попытка ${item.headers[HEADER.attempt] ?? '?'}`,
      );
    }
    lab.observe(
      `в очереди ${queued.length} сообщений: байты совпали с исходными у ${sameBytes}, ключ сохранён у ${sameKeys}`,
    );
    lab.observe(
      `диагностика едет заголовками ${HEADER.errorClass}, ${HEADER.error}, ${HEADER.originTopic}, ${HEADER.originPartition}, ${HEADER.originOffset}, ${HEADER.attempt}, ${HEADER.firstFailedAt}, ${HEADER.consumerGroup}`,
    );
    lab.observe(`строк в таблице очереди ${table.length}, все ждут разбора`);

    lab.step(`Устраняю причину у одного кадра: прибор ${LATE_DEVICE} появился в топологии`);
    devices.add(LATE_DEVICE);
    lab.note('остальные четыре испорчены в самих байтах: от повтора их разбор не изменится');

    lab.step('Первый запрос повторной подачи: строки возвращаются в исходный топик своим ключом');
    const beforeFirst = traffic.length;
    const first = await redrive();
    lab.observe(
      `запрос вернул: подано ${first.redriven}, окончательно отвергнуто ${first.rejected}`,
    );
    await lab.waitFor('копии дошли до потребителя', passed(beforeFirst + first.redriven));
    const wave = traffic.slice(beforeFirst);
    const back = wave.filter((pass) => pass.errorClass === null);
    lab.observe(
      `из ${wave.length} копий разобралось ${back.length}: ${back.map((pass) => pass.key ?? 'без ключа').join(', ')}, причина была снаружи кадра`,
    );
    lab.observe(
      `остальные ${wave.length - back.length} упали на том же месте: ${classCounts(wave)}, счёт попыток стал 2`,
    );
    lab.observe(
      `копия легла в ту же партицию, что и исходный кадр: совпало ${samePartition(traffic, beforeFirst)} из ${wave.length}`,
    );
    lab.observe(
      `строки закрыла сама подача, копиями закрыто ещё ${closedByCopy}: прежняя отметка не перетирается`,
    );

    lab.step('Второй запрос: те же четыре строки идут по кругу');
    const beforeSecond = traffic.length;
    const second = await redrive();
    lab.observe(
      `запрос вернул: подано ${second.redriven}, окончательно отвергнуто ${second.rejected}`,
    );
    await lab.waitFor('копии дошли до потребителя', passed(beforeSecond + second.redriven));
    const third = traffic.slice(beforeSecond);
    lab.observe(
      `не разобралось ${third.filter((pass) => pass.errorClass !== null).length} из ${third.length}, счёт попыток дошёл до ${FINAL_ATTEMPTS}`,
    );

    lab.step('Третий запрос: попытки исчерпаны');
    const last = await redrive();
    lab.observe(`запрос вернул: подано ${last.redriven}, окончательно отвергнуто ${last.rejected}`);
    await lab.waitFor('очередь получила все копии', () => queued.length >= table.length);
    const rejectedRows = table.filter((row) => row.finalRejected);
    lab.observe(
      `в таблице ${table.length} строк: разобрано ${table.filter((row) => row.resolvedAt !== null).length}, окончательно отвергнуто ${rejectedRows.length}, ждут подачи ${pendingRows(table, REDRIVE_LIMIT).length}`,
    );
    lab.observe(
      `отвергнуты с попыткой ${FINAL_ATTEMPTS}: ${rejectedRows.map((row) => `${row.key ?? 'без ключа'} ${row.error.class}`).join(', ')}`,
    );
    const firstFailures = frames.length - accepted.length;
    lab.observe(
      `в учебной очереди ${queued.length} сообщений: ${firstFailures} от первых неудач и ${queued.length - firstFailures} от повторных подач`,
    );
    lab.observe(`через потребителя прошло ${traffic.length} сообщений, отказов потребителя 0`);

    lab.step('Смотрю боевые топики стенда, только чтением концов партиций');
    lab.observe(`${LIVE_RAW_TOPIC}: ${countText(await topicCount(lab, LIVE_RAW_TOPIC))}`);
    lab.observe(`${LIVE_DLQ_TOPIC}: ${countText(await topicCount(lab, LIVE_DLQ_TOPIC))}`);

    lab.conclude(
      'неразбираемое сообщение не останавливает партицию: оно уезжает в очередь недоставленных ' +
        'байт в байт, с исходным ключом и причиной в заголовках, а разбор идёт со следующего. ' +
        'Повторная подача возвращает его в исходный топик тем же ключом и помогает только тогда, ' +
        'когда причина была снаружи байтов; неизменные байты падают на том же месте, и на третьей ' +
        'неудаче строка помечается окончательно отвергнутой и из круга выходит.',
    );
  },
};
