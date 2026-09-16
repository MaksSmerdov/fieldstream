import type { Producer } from 'kafkajs';
import type { Experiment, Lab, LabTimer } from '../experiment.js';
import { errorText } from '../lab.js';
import { formatDuration } from '../report.js';

/** Партиции учебного топика и раскладка подачи: нулевая партиция получает вдвое больше соседних. */
const PARTITIONS = 3;
const FEED_PLAN = [0, 0, 1, 2];

/**
 * Подача и разбор: пачка раз в шаг это 100 сообщений в секунду, задержка 40 мс на сообщение это
 * около 25. В быстрой фазе задержка ставится на каждое десятое сообщение: таймер короче тика
 * планировщика всё равно не спит, а так темп разбора выходит примерно шестьсот в секунду.
 */
const FEED_BATCH = 20;
const FEED_STEP_MS = 200;
const SLOW_MS = 40;
const FAST_MS = 15;
const FAST_EVERY = 10;
const COMMIT_MS = 200;

/** Размеры и пределы прогона. */
const PREFILL = 300;
const GROW_MS = 12_000;
const WATCH_STEP_MS = 3_000;
const BURST = 400;
const JOIN_LIMIT_MS = 30_000;
const IDLE_LIMIT_MS = 20_000;
const DRAIN_LIMIT_MS = 45_000;
const DRAIN_STEP_MS = 500;

const NONE = 'нет';

/** Подтверждённое смещение группы: '-1' в ответе брокера означает, что коммита не было. */
const committedOffset = (offset: string): number | null => {
  const value = Number(offset);
  return Number.isInteger(value) && value >= 0 ? value : null;
};

/** Одна партиция снимка: конец, подтверждённое смещение группы и разность между ними. */
interface PartitionLag {
  readonly partition: number;
  readonly high: number;
  readonly committed: number | null;
  readonly lag: number | null;
}

/** Снимок отставания группы по топику: по партициям и суммами. */
interface LagSnapshot {
  readonly rows: readonly PartitionLag[];
  readonly high: number;
  readonly committed: number;
  readonly total: number;
  readonly commits: number;
}

/** Замер роста: снимок и момент, когда он снят. */
interface Mark {
  readonly atMs: number;
  readonly snapshot: LagSnapshot;
}

/**
 * Снимок отставания теми же двумя вызовами, что и снимок конвейера в шлюзе: концы партиций
 * против подтверждённых смещений группы. Партиция без коммита даёт не ноль, а неизвестность.
 */
const readLag = async (lab: Lab, topic: string, groupId: string): Promise<LagSnapshot> => {
  const [ends, committed] = await Promise.all([
    lab.admin.fetchTopicOffsets(topic),
    lab.admin.fetchOffsets({ groupId, topics: [topic] }),
  ]);

  const offsets = new Map<number, number>();
  for (const item of committed) {
    for (const part of item.partitions) {
      const offset = committedOffset(part.offset);
      if (offset !== null) offsets.set(part.partition, offset);
    }
  }

  const rows: PartitionLag[] = ends
    .map((end) => {
      const high = Number(end.high);
      const offset = offsets.get(end.partition) ?? null;

      return {
        partition: end.partition,
        high,
        committed: offset,
        lag: offset === null ? null : Math.max(0, high - offset),
      };
    })
    .sort((left, right) => left.partition - right.partition);

  return {
    rows,
    high: rows.reduce((sum, row) => sum + row.high, 0),
    committed: rows.reduce((sum, row) => sum + (row.committed ?? 0), 0),
    total: rows.reduce((sum, row) => sum + (row.lag ?? 0), 0),
    commits: rows.filter((row) => row.committed !== null).length,
  };
};

/** Заголовок таблицы отставания. */
const lagHead = (): string =>
  `${'когда'.padStart(7)}${'конец'.padStart(8)}${'подтверждено'.padStart(14)}` +
  `${'отставание'.padStart(12)}   по партициям`;

/** Строка таблицы отставания: одно измерение снимка. */
const lagLine = (label: string, snapshot: LagSnapshot): string => {
  const known = snapshot.commits > 0;
  const perPartition = snapshot.rows
    .map((row) => (row.lag === null ? NONE : String(row.lag)))
    .join(' / ');

  return (
    label.padStart(7) +
    String(snapshot.high).padStart(8) +
    (known ? String(snapshot.committed) : NONE).padStart(14) +
    (known ? String(snapshot.total) : NONE).padStart(12) +
    `   ${perPartition}`
  );
};

/** Число для протокола: один знак после запятой, неизвестное пишется словом. */
const num = (value: number | null): string =>
  value === null || !Number.isFinite(value) ? NONE : value.toFixed(1);

/** Отставание во времени по счёту шлюза: сумма отставания делится на темп топика. */
const lagSeconds = (total: number, rate: number): number | null => (rate > 0 ? total / rate : null);

/**
 * Отправка пачки: номер сообщения задаёт партицию, поэтому раскладка подачи известна заранее.
 * В сообщение кладётся отметка секундомера опыта: по ней разбор считает возраст сообщения.
 */
const send = async (
  producer: Producer,
  topic: string,
  from: number,
  count: number,
  clock: LabTimer,
): Promise<void> => {
  const at = Math.round(clock.ms());

  await producer.send({
    topic,
    messages: Array.from({ length: count }, (_, index) => {
      const number = from + index;

      return {
        key: `n-${String(number)}`,
        value: JSON.stringify({ number, at }),
        partition: FEED_PLAN[number % FEED_PLAN.length] ?? 0,
      };
    }),
  });
};

/** Отметка из сообщения: часы у подачи и разбора одни, поэтому возраст считается вычитанием. */
const stampOf = (value: Buffer | null): number | null => {
  if (value === null) return null;

  const parsed: unknown = JSON.parse(value.toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null) return null;

  const at: unknown = (parsed as Record<string, unknown>).at;

  return typeof at === 'number' ? at : null;
};

/** Ровная подача в топик: пачка раз в шаг, пока не остановят. Остановка отдаёт число сообщений. */
const startFeed = (
  lab: Lab,
  producer: Producer,
  topic: string,
  from: number,
  clock: LabTimer,
): { readonly stop: () => Promise<number> } => {
  const feed: { sent: number; live: boolean; failure: unknown } = {
    sent: 0,
    live: true,
    failure: null,
  };

  const loop = (async (): Promise<void> => {
    while (feed.live) {
      await send(producer, topic, from + feed.sent, FEED_BATCH, clock);
      feed.sent += FEED_BATCH;
      await lab.sleep(FEED_STEP_MS);
    }
  })().catch((error: unknown) => {
    feed.failure = error;
  });

  return {
    stop: async () => {
      feed.live = false;
      await loop;
      if (feed.failure !== null) throw new Error(`подача оборвалась: ${errorText(feed.failure)}`);

      return feed.sent;
    },
  };
};

/** Опыт: отставание как наблюдаемая величина. */
export const lag: Experiment = {
  name: 'lag',
  title: 'отставание как наблюдаемая величина',
  run: async (lab) => {
    const clock = lab.timer();
    const topic = await lab.topic('feed', { partitions: PARTITIONS });
    const groupId = lab.groupId('reader');
    const producer = await lab.producer();

    lab.step(
      `топик на ${String(PARTITIONS)} партиции, ${String(PREFILL)} сообщений, потребителя нет`,
    );
    await send(producer, topic, 0, PREFILL, clock);
    const idle = await readLag(lab, topic, groupId);
    lab.note(lagHead());
    lab.note(lagLine('сразу', idle));
    lab.observe(`конец топика ${String(idle.high)}, группы ${groupId} у брокера нет`);
    lab.note('подтверждённых смещений он не отдаёт, и отставание не ноль, а неизвестно');
    lab.note(
      'в снимке конвейера такая партиция получила бы lag: null, а группа в список не попала бы',
    );

    lab.step('медленный потребитель против ровной подачи: около 100 сообщений в секунду против 25');
    const pace = { ms: SLOW_MS, every: 1 };
    const seen = { count: 0, ageMs: 0 };
    const consumer = await lab.consumer('reader', {
      maxBytesPerPartition: 2_048,
      maxWaitTimeInMs: 1_000,
    });
    await consumer.subscribe({ topic, fromBeginning: true });
    await consumer.run({
      autoCommit: true,
      autoCommitInterval: COMMIT_MS,
      eachMessage: async ({ message }) => {
        const at = stampOf(message.value);
        seen.count += 1;
        if (at !== null) seen.ageMs = clock.ms() - at;
        if (seen.count % pace.every === 0) await lab.sleep(pace.ms);
      },
    });
    await lab.waitFor(
      'потребитель отчитался хотя бы одним смещением на каждой партиции',
      async () => (await readLag(lab, topic, groupId)).commits === PARTITIONS,
      { limitMs: JOIN_LIMIT_MS, stepMs: COMMIT_MS },
    );
    lab.note('замер начинается, когда коммит есть на каждой партиции: до этого отставание неполно');

    const feed = startFeed(lab, producer, topic, PREFILL, clock);
    const watch = lab.timer();
    const marks: Mark[] = [];
    lab.note(lagHead());

    while (watch.ms() < GROW_MS) {
      await lab.sleep(WATCH_STEP_MS);
      const snapshot = await readLag(lab, topic, groupId);
      marks.push({ atMs: watch.ms(), snapshot });
      lab.note(lagLine(`${(watch.ms() / 1000).toFixed(0)} с`, snapshot));
    }

    const sent = await feed.stop();
    const first = marks[0];
    const last = marks.at(-1);
    if (first === undefined || last === undefined || last === first) {
      throw new Error('замеров роста не хватило: шаг наблюдения длиннее самой фазы роста');
    }

    const span = (last.atMs - first.atMs) / 1000;
    const intake = (last.snapshot.high - first.snapshot.high) / span;
    const growth = (last.snapshot.total - first.snapshot.total) / span;
    const slowAgeMs = seen.ageMs;
    const slowTotal = last.snapshot.total;
    const byPartition = last.snapshot.rows.map((row) => String(row.lag ?? NONE)).join(' / ');

    lab.observe(
      `отставание выросло с ${String(first.snapshot.total)} до ${String(slowTotal)} ` +
        `за ${num(span)} с, это ${num(growth)} сообщений в секунду`,
    );
    lab.note(
      `подача шла ${num(intake)} сообщений в секунду, разбор ${num(intake - growth)}: ` +
        'рост это разность двух темпов, а не свойство топика',
    );
    lab.observe(
      `по партициям ${byPartition}: нулевая нагружена вдвое, отставание повторило раскладку`,
    );
    lab.observe(`последнее разобранное сообщение пролежало в топике ${num(slowAgeMs / 1000)} с`);

    lab.step('потребитель встал, подача идёт разовым вбросом: отставание берёт ступеньку');
    consumer.pause([{ topic }]);
    let previous = -1;
    await lab.waitFor(
      'подтверждённые смещения перестали двигаться',
      async () => {
        const snapshot = await readLag(lab, topic, groupId);
        const stopped = snapshot.committed === previous;
        previous = snapshot.committed;

        return stopped;
      },
      { limitMs: IDLE_LIMIT_MS, stepMs: COMMIT_MS },
    );

    const before = await readLag(lab, topic, groupId);
    await send(producer, topic, PREFILL + sent, BURST, clock);
    const after = await readLag(lab, topic, groupId);
    lab.note(lagHead());
    lab.note(lagLine('до', before));
    lab.note(lagLine('после', after));
    lab.observe(
      `конец вырос на ${String(after.high - before.high)}, подтверждённое смещение осталось ` +
        `${String(after.committed)}, отставание поднялось на ${String(after.total - before.total)}`,
    );
    lab.note('это ступенька, а не наклон: простой потребителя виден по обрыву подтверждений');

    lab.step('потребитель вернулся и разбирает быстрее подачи: отставание сходит');
    const backlog = after.total;
    pace.ms = FAST_MS;
    pace.every = FAST_EVERY;
    consumer.resume([{ topic }]);
    const drain = lab.timer();
    const woke: { mark: Mark | null } = { mark: null };
    lab.note(lagHead());
    await lab.waitFor(
      'отставание сошло до нуля',
      async () => {
        const snapshot = await readLag(lab, topic, groupId);
        if (woke.mark === null && snapshot.total < backlog) {
          woke.mark = { atMs: drain.ms(), snapshot };
        }
        lab.note(lagLine(`${(drain.ms() / 1000).toFixed(1)} с`, snapshot));

        return snapshot.total === 0;
      },
      { limitMs: DRAIN_LIMIT_MS, stepMs: DRAIN_STEP_MS },
    );

    const drainMs = drain.ms();
    const wake: Mark = woke.mark ?? { atMs: 0, snapshot: after };
    const drainRate = wake.snapshot.total / ((drainMs - wake.atMs) / 1000);
    lab.observe(
      `${String(wake.snapshot.total)} сообщений разошлись за ` +
        `${formatDuration(drainMs - wake.atMs)}, это ${num(drainRate)} сообщений в секунду`,
    );
    lab.note(
      `первое движение пошло через ${num(wake.atMs / 1000)} с после снятия паузы: ` +
        'клиент со всеми остановленными партициями возвращается к опросу не мгновенно',
    );
    lab.note(
      `в темп входит и подтверждение: коммит идёт не чаще раза в ${String(COMMIT_MS)} мс, ` +
        `а отставание читается раз в ${String(DRAIN_STEP_MS)} мс`,
    );

    lab.step('отставание в сообщениях против отставания во времени');
    lab.note(
      `на пике медленной фазы было ${String(slowTotal)} сообщений при подаче ` +
        `${num(intake)} в секунду`,
    );
    lab.observe(
      `по счёту шлюза это ${num(lagSeconds(slowTotal, intake))} с: сумма отставания на темп топика`,
    );
    lab.observe(
      `возраст последнего разобранного сообщения был ${num(slowAgeMs / 1000)} с, ` +
        'два счёта сходятся, пока подача ровная',
    );
    lab.observe(
      `при быстром разборе то же отставание стоило бы ` +
        `${num(lagSeconds(slowTotal, drainRate))} с: одно число сообщений это разное время`,
    );

    lab.conclude(
      'отставание это конец партиции минус подтверждённое смещение группы: без группы и без коммита ' +
        'числа нет, ровный рост показывает нехватку скорости, ступенька простой, ' +
        'а секунды выходят только делением на темп топика',
    );
  },
};
