import { describe, expect, it } from 'vitest';
import { REPLAY_RETENTION_MS, replayRequestSchema } from '@fieldstream/contracts';
import type { AlarmRule, ReplayPatch } from '@fieldstream/contracts';
import type { ReplayEpisodeSummaryRow } from '@fieldstream/db';
import { toIsoTimestamp } from '@fieldstream/domain';
import {
  applyPatches,
  busyMessage,
  changedRulesOf,
  diffRowsOf,
  liveWindowOf,
  millisecondWindowOf,
  parseRulesSnapshot,
  replayErrorMap,
  unfinishedMessage,
  unknownDevicesOf,
  windowIssues,
} from '../src/replay/replay-calc.js';

const NOW = Date.parse('2026-09-15T10:00:00.000Z');

const rule = (patch: Partial<AlarmRule>): AlarmRule => ({
  deviceCode: 'RC-101',
  metricKey: 'evap_temp_c',
  mode: 'defrost',
  minValue: -28,
  maxValue: 12,
  hysteresis: 1,
  debounceCycles: 6,
  severity: 'info',
  enabled: true,
  ...patch,
});

const BASELINE: readonly AlarmRule[] = [
  rule({}),
  rule({ mode: 'cooling', maxValue: 0, debounceCycles: 3 }),
  rule({ deviceCode: 'RC-102' }),
  rule({
    deviceCode: 'PM-201',
    metricKey: 'current_l1_a',
    mode: 'cooling',
    minValue: null,
    maxValue: 70,
    hysteresis: 2,
    debounceCycles: 3,
    severity: 'warning',
  }),
];

const patch = (fields: Omit<ReplayPatch, 'metricKey' | 'mode'>): ReplayPatch => ({
  metricKey: 'evap_temp_c',
  mode: 'defrost',
  ...fields,
});

/** Правки применились: уставки варианта «стало». */
const appliedRules = (patches: readonly ReplayPatch[]): AlarmRule[] => {
  const outcome = applyPatches(BASELINE, patches);
  if (!outcome.ok) throw new Error(`правки отклонены: ${outcome.issues.join('; ')}`);
  return outcome.rules;
};

/** Правки отклонены: причины отказа. */
const rejectedIssues = (
  baseline: readonly AlarmRule[],
  patches: readonly ReplayPatch[],
): string[] => {
  const outcome = applyPatches(baseline, patches);
  if (outcome.ok) throw new Error('правки приняты, а ждали отказа');
  return outcome.issues;
};

const summaryRow = (
  deviceCode: string,
  metricKey: string,
  counts: Pick<ReplayEpisodeSummaryRow, 'baseline' | 'patched' | 'added' | 'removed'>,
): ReplayEpisodeSummaryRow => ({ deviceCode, metricKey, mode: 'cooling', ...counts });

describe('правка уставок перепрогона', () => {
  it('правка ложится на все выбранные приборы с такой уставкой, остальные уставки не трогаются', () => {
    const rules = appliedRules([patch({ maxValue: 8 })]);

    expect(
      rules.map((item) => [item.deviceCode, item.metricKey, item.mode, item.maxValue]),
    ).toEqual([
      ['RC-101', 'evap_temp_c', 'defrost', 8],
      ['RC-101', 'evap_temp_c', 'cooling', 0],
      ['RC-102', 'evap_temp_c', 'defrost', 8],
      ['PM-201', 'current_l1_a', 'cooling', 70],
    ]);
    expect(BASELINE[0]?.maxValue).toBe(12);
  });

  it('null снимает границу, отсутствующее поле оставляет значение как было', () => {
    const [patched] = appliedRules([patch({ minValue: null, hysteresis: 2, enabled: false })]);

    expect(patched).toEqual(
      rule({ minValue: null, maxValue: 12, hysteresis: 2, debounceCycles: 6, enabled: false }),
    );
  });

  it('правка без подходящей уставки отклоняется, все причины собираются разом', () => {
    expect(
      rejectedIssues(BASELINE, [
        { metricKey: 'superheat_k', mode: 'defrost', maxValue: 5 },
        patch({ maxValue: 8 }),
        { metricKey: 'evap_temp_c', mode: 'service', enabled: false },
      ]),
    ).toEqual([
      'правка superheat_k/defrost: у выбранных приборов нет такой уставки',
      'правка evap_temp_c/service: у выбранных приборов нет такой уставки',
    ]);
  });

  it('нижняя граница не ниже верхней после применения отклоняется с прибором, метрикой и режимом', () => {
    expect(rejectedIssues(BASELINE, [patch({ minValue: 12 })])).toEqual([
      'правка evap_temp_c/defrost: уставка RC-101/evap_temp_c/defrost: minValue должен быть меньше maxValue',
      'правка evap_temp_c/defrost: уставка RC-102/evap_temp_c/defrost: minValue должен быть меньше maxValue',
    ]);
  });

  it('снятая единственная граница отклоняется: уставке нужна хотя бы одна', () => {
    expect(
      rejectedIssues(BASELINE, [{ metricKey: 'current_l1_a', mode: 'cooling', maxValue: null }]),
    ).toEqual([
      'правка current_l1_a/cooling: уставка PM-201/current_l1_a/cooling: нужна хотя бы одна граница',
    ]);
  });

  it('правка, ничего не меняющая, и пустая правка отклоняются', () => {
    expect(rejectedIssues(BASELINE, [patch({ maxValue: 12, enabled: true })])).toEqual([
      'правка evap_temp_c/defrost: значения совпадают с текущими, сравнивать нечего',
    ]);
    expect(rejectedIssues(BASELINE, [patch({})])).toEqual([
      'правка evap_temp_c/defrost: значения совпадают с текущими, сравнивать нечего',
    ]);
  });

  it('правка, меняющая уставку хотя бы одного прибора, принимается', () => {
    const baseline = [rule({}), rule({ deviceCode: 'RC-102', maxValue: 10 })];
    const outcome = applyPatches(baseline, [patch({ maxValue: 12 })]);

    expect(outcome.ok && outcome.rules.map((item) => item.maxValue)).toEqual([12, 12]);
  });

  it('порог уставки, выключенной у всех приборов, не правится; включение её принимается', () => {
    const baseline = [rule({ enabled: false }), rule({ deviceCode: 'RC-102', enabled: false })];

    expect(rejectedIssues(baseline, [patch({ maxValue: 8 })])).toEqual([
      'правка evap_temp_c/defrost: уставка выключена у всех выбранных приборов и на срабатывания не влияет, включите её в правке (enabled: true)',
    ]);

    const outcome = applyPatches(baseline, [patch({ maxValue: 8, enabled: true })]);
    expect(outcome.ok && outcome.rules.map((item) => [item.maxValue, item.enabled])).toEqual([
      [8, true],
      [8, true],
    ]);

    const mixed = applyPatches(
      [...baseline, rule({ deviceCode: 'RC-103' })],
      [patch({ maxValue: 8 })],
    );
    expect(mixed.ok).toBe(true);
  });

  it('у включённой уставки значения уже такие, у выключенной правка ни на что не влияет: текст не зовёт включать', () => {
    const baseline = [rule({ enabled: false }), rule({ deviceCode: 'RC-102', maxValue: 8 })];

    expect(rejectedIssues(baseline, [patch({ maxValue: 8 })])).toEqual([
      'правка evap_temp_c/defrost: у включённых уставок значения совпадают с текущими, а у выключенных правка на срабатывания не влияет',
    ]);
  });
});

describe('тексты стандартных проверок запроса', () => {
  const messagesOf = (body: unknown): string[] => {
    const parsed = replayRequestSchema.safeParse(body, { errorMap: replayErrorMap });
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
  };
  const valid = {
    from: toIsoTimestamp(NOW - 3_600_000),
    to: toIsoTimestamp(NOW),
    deviceCodes: ['RC-101'],
    patches: [patch({ maxValue: 8 })],
  };

  it('по-русски и с полем, к которому относятся', () => {
    expect(messagesOf({ ...valid, from: undefined })).toEqual(['from: обязательное поле']);
    expect(messagesOf({ ...valid, from: 'вчера' })).toEqual([
      'from: ожидается время ISO 8601, например 2026-09-15T10:00:00.000Z',
    ]);
    expect(
      messagesOf({
        ...valid,
        patches: [
          patch({ maxValue: 8 }),
          { metricKey: 'supply_temp_c', mode: 'cooling', hysteresis: 5_000 },
        ],
      }),
    ).toEqual(['patches.1.hysteresis: не больше 1000']);
    expect(
      messagesOf({
        ...valid,
        patches: [{ metricKey: 'evap_temp_c', mode: 'heating', maxValue: 8 }],
      }),
    ).toEqual(['patches.0.mode: допустимо cooling, defrost, service, off']);
    expect(messagesOf({ ...valid, patches: [patch({ debounceCycles: 1.5 })] })).toEqual([
      'patches.0.debounceCycles: ожидается целое число',
    ]);
    expect(messagesOf({ ...valid, promote: true })).toEqual(['запрос: лишние поля promote']);
  });

  it('сообщения, заданные в схеме, остаются как есть', () => {
    expect(messagesOf({ ...valid, patches: [] })).toEqual(['нужна хотя бы одна правка']);
    expect(messagesOf({ ...valid, deviceCodes: ['rc-101'] })).toEqual([
      'ожидается вид RC-101 или PM-201',
    ]);
  });
});

describe('окно и приборы запроса', () => {
  it('начало не старше срока хранения сырых кадров с минутой допуска, конец не позже минуты после сейчас', () => {
    const to = toIsoTimestamp(NOW);
    const oldestMs = NOW - REPLAY_RETENTION_MS;

    expect(windowIssues({ from: toIsoTimestamp(oldestMs), to }, NOW)).toEqual([]);
    expect(windowIssues({ from: toIsoTimestamp(oldestMs - 60_000), to }, NOW)).toEqual([]);
    expect(windowIssues({ from: toIsoTimestamp(oldestMs - 60_001), to }, NOW)).toEqual([
      `начало окна раньше ${toIsoTimestamp(NOW - REPLAY_RETENTION_MS)}: более старые сырые кадры брокер уже удалил`,
    ]);

    const from = toIsoTimestamp(NOW - 3_600_000);
    expect(windowIssues({ from, to: toIsoTimestamp(NOW + 60_000) }, NOW)).toEqual([]);
    expect(windowIssues({ from, to: toIsoTimestamp(NOW + 60_001) }, NOW)).toEqual([
      'конец окна в будущем: перепрогнать можно только уже собранные кадры',
    ]);
  });

  it('окно приводится к миллисекундам в UTC: база не округлит начало до конца', () => {
    const request = {
      from: '2026-09-15T10:00:00.1239999Z',
      to: '2026-09-15T13:00:00.124+03:00',
      deviceCodes: ['RC-101'],
    };

    expect(millisecondWindowOf(request)).toEqual({
      from: '2026-09-15T10:00:00.123Z',
      to: '2026-09-15T10:00:00.124Z',
      deviceCodes: ['RC-101'],
    });
  });

  it('приборы, которых нет в топологии, перечисляются', () => {
    const known = new Map([['RC-101', {}]]);

    expect(unknownDevicesOf(['RC-101', 'RC-999', 'PM-299'], known)).toEqual(['RC-999', 'PM-299']);
  });
});

describe('итог прогона', () => {
  it('снимок уставок разбирается общей схемой, у испорченного причины называют вариант и поле', () => {
    expect(parseRulesSnapshot({ baseline: [rule({})], patched: [rule({ maxValue: 8 })] })).toEqual({
      ok: true,
      snapshot: { baseline: [rule({})], patched: [rule({ maxValue: 8 })] },
    });

    const broken = parseRulesSnapshot({
      baseline: [rule({ minValue: 20 })],
      patched: [{ ...rule({}), severity: 'fatal' }],
    });
    expect(broken.ok).toBe(false);
    expect(broken.ok ? [] : broken.issues.map((issue) => issue.split(':')[0])).toEqual([
      'baseline.0.minValue',
      'patched.0.severity',
    ]);

    expect(parseRulesSnapshot({ baseline: 'не массив', patched: [] })).toMatchObject({
      ok: false,
    });
  });

  it('изменённые уставки только те, что правка поменяла, по прибору, метрике и режиму', () => {
    const baseline = [
      rule({ deviceCode: 'RC-102' }),
      rule({}),
      rule({ mode: 'cooling', maxValue: 0 }),
    ];
    const patched = baseline.map((item) =>
      item.mode === 'defrost' ? { ...item, maxValue: 8 } : item,
    );
    const values = {
      minValue: -28,
      maxValue: 12,
      hysteresis: 1,
      debounceCycles: 6,
      severity: 'info',
      enabled: true,
    };

    expect(changedRulesOf({ baseline, patched })).toEqual([
      {
        deviceCode: 'RC-101',
        metricKey: 'evap_temp_c',
        mode: 'defrost',
        baseline: values,
        patched: { ...values, maxValue: 8 },
      },
      {
        deviceCode: 'RC-102',
        metricKey: 'evap_temp_c',
        mode: 'defrost',
        baseline: values,
        patched: { ...values, maxValue: 8 },
      },
    ]);
  });

  it('уставка, выключенная и до правки, и после, изменённой не считается', () => {
    const baseline = [rule({}), rule({ deviceCode: 'RC-102', enabled: false })];
    const outcome = applyPatches(baseline, [patch({ maxValue: 8 })]);
    if (!outcome.ok) throw new Error(`правки отклонены: ${outcome.issues.join('; ')}`);

    expect(
      changedRulesOf({ baseline, patched: outcome.rules }).map((item) => item.deviceCode),
    ).toEqual(['RC-101']);

    const enabling = applyPatches(baseline, [patch({ enabled: true })]);
    if (!enabling.ok) throw new Error(`правки отклонены: ${enabling.issues.join('; ')}`);
    expect(
      changedRulesOf({ baseline, patched: enabling.rules }).map((item) => item.deviceCode),
    ).toEqual(['RC-102']);
  });

  it('живые эпизоды считаются по фактическому покрытию включительно, без покрытия не считаются', () => {
    const deviceCodes = ['RC-101'];

    expect(liveWindowOf({ coveredFrom: null, coveredTo: null, deviceCodes })).toBeNull();
    expect(
      liveWindowOf({
        coveredFrom: '2026-09-15T09:10:00.000Z',
        coveredTo: '2026-09-15T09:50:00.000Z',
        deviceCodes,
      }),
    ).toEqual({
      from: '2026-09-15T09:10:00.000Z',
      to: '2026-09-15T09:50:00.001Z',
      deviceCodes,
    });
  });

  it('строки разницы: живые прикладываются к сводке, сверху эпизоды без пары, затем разница счёта', () => {
    const rows = diffRowsOf(
      [
        summaryRow('RC-102', 'supply_temp_c', { baseline: 1, patched: 1, added: 0, removed: 0 }),
        summaryRow('RC-101', 'evap_temp_c', { baseline: 0, patched: 2, added: 2, removed: 0 }),
        summaryRow('RC-100', 'supply_temp_c', { baseline: 2, patched: 2, added: 1, removed: 1 }),
        summaryRow('RC-103', 'evap_temp_c', { baseline: 3, patched: 0, added: 0, removed: 3 }),
      ],
      [
        { deviceCode: 'RC-101', metricKey: 'evap_temp_c', mode: 'cooling', episodes: 1 },
        { deviceCode: 'RC-104', metricKey: 'return_temp_c', mode: 'cooling', episodes: 2 },
      ],
    );

    expect(
      rows.map((row) => [row.deviceCode, row.metricKey, row.added, row.removed, row.live]),
    ).toEqual([
      ['RC-103', 'evap_temp_c', 0, 3, 0],
      ['RC-101', 'evap_temp_c', 2, 0, 1],
      ['RC-100', 'supply_temp_c', 1, 1, 0],
      ['RC-102', 'supply_temp_c', 0, 0, 0],
      ['RC-104', 'return_temp_c', 0, 0, 2],
    ]);
    expect(rows[4]).toEqual({
      deviceCode: 'RC-104',
      metricKey: 'return_temp_c',
      mode: 'cooling',
      baseline: 0,
      patched: 0,
      added: 0,
      removed: 0,
      live: 2,
    });
  });

  it('без эпизодов и живых строк нет', () => {
    expect(diffRowsOf([], [])).toEqual([]);
  });
});

describe('тексты занятого стенда и незавершённого прогона', () => {
  it('занятый стенд называет состояние прогона и того, кто его запустил', () => {
    const requestedBy = 'engineer@fieldstream.local';

    expect(busyMessage({ status: 'queued', requestedBy })).toBe(
      'перепрогон на стенде уже ждёт процессора, его запустил engineer@fieldstream.local: дождитесь итога и повторите запуск',
    );
    expect(busyMessage({ status: 'running', requestedBy })).toBe(
      'перепрогон на стенде уже идёт, его запустил engineer@fieldstream.local: дождитесь итога и повторите запуск',
    );
    expect(busyMessage(null)).toBe('на стенде уже идёт другой перепрогон, повторите запуск позже');
  });

  it('итога нет, пока прогон ждёт или идёт, у проваленного называется причина', () => {
    expect(unfinishedMessage({ status: 'queued', error: null })).toBe(
      'прогон ждёт процессора: итог появится после завершения',
    );
    expect(unfinishedMessage({ status: 'running', error: null })).toBe(
      'прогон ещё идёт: итог появится после завершения',
    );
    expect(unfinishedMessage({ status: 'failed', error: 'процессор остановлен' })).toBe(
      'прогон завершён с ошибкой, итога нет: процессор остановлен',
    );
    expect(unfinishedMessage({ status: 'failed', error: null })).toBe(
      'прогон завершён с ошибкой, итога нет: причина не записана',
    );
  });
});
