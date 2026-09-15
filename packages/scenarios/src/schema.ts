import {
  breakerStateSchema,
  deviceCodeSchema,
  deviceModeSchema,
  healthReasonSchema,
  healthStatusSchema,
  lineCodeSchema,
  simClearFaultsQuerySchema,
  simFaultRequestSchema,
  simScenarioNameSchema,
} from '@fieldstream/contracts';
import { z } from 'zod';

/** Имя сценария и имя базовой длительности: kebab-case. */
export const KEBAB_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Предел любого ожидания в сценарии, секунды. */
const MAX_WAIT_SEC = 3_600;

/** Сколько попыток переподключения сборщик хранит в снимке линии. */
const RECONNECT_HISTORY = 12;

/** Запись вида { kind, ...поля варианта } по таблице вариантов. */
type Tagged<V extends Record<string, z.ZodTypeAny>> = {
  [K in keyof V & string]: { readonly kind: K } & z.output<V[K]>;
}[keyof V & string];

/** Объект ровно с одним ключом из таблицы вариантов: ключ становится полем kind. */
const oneKeyOf = <V extends Record<string, z.ZodTypeAny>>(
  what: string,
  variants: V,
): z.ZodType<Tagged<V>, z.ZodTypeDef, unknown> => {
  const table = new Map<string, z.ZodTypeAny>(Object.entries(variants));
  const known = [...table.keys()].join(', ');

  return z
    .record(z.string(), z.unknown(), {
      invalid_type_error: `${what}: ожидается объект с одним ключом из ${known}`,
    })
    .transform((value, ctx) => {
      const keys = Object.keys(value);
      const [key] = keys;

      if (key === undefined || keys.length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            key === undefined
              ? `${what}: нужен ровно один ключ из ${known}, а ключей нет`
              : `${what}: нужен ровно один ключ, а заданы ${keys.join(', ')}`,
        });
        return z.NEVER;
      }

      const variant = table.get(key);
      if (variant === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${what}: неизвестный вид «${key}», ожидается один из ${known}`,
          path: [key],
        });
        return z.NEVER;
      }

      const parsed = variant.safeParse(value[key]);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue, path: [key, ...issue.path] });
        }
        return z.NEVER;
      }

      const data: unknown = parsed.data;
      const tagged: unknown = Object.assign({ kind: key }, data);
      return tagged as Tagged<V>;
    });
};

/** Пустое значение в YAML (ключ без содержимого) читается как пустой объект. */
const emptyWhenNull = (value: unknown): unknown => value ?? {};

const kebabNameSchema = z
  .string()
  .regex(KEBAB_NAME_PATTERN, 'ожидается имя в kebab-case, например l2-cycle');

const waitSecSchema = z.number().int().min(1).max(MAX_WAIT_SEC);

/** Проверки состояния стенда, которые шаги ждут или удерживают. */
export const probeSchema = oneKeyOf('проба', {
  breaker: z.object({ deviceCode: deviceCodeSchema, state: breakerStateSchema }).strict(),
  device: z
    .object({
      deviceCode: deviceCodeSchema,
      status: healthStatusSchema.optional(),
      reason: healthReasonSchema.optional(),
      mode: deviceModeSchema.optional(),
    })
    .strict()
    .refine(
      (probe) =>
        probe.status !== undefined || probe.reason !== undefined || probe.mode !== undefined,
      { message: 'проба прибора: нужно хотя бы одно из status, reason, mode' },
    ),
  line: z
    .object({
      lineCode: lineCodeSchema,
      connected: z.boolean().optional(),
      reconnectsAtLeast: z
        .number()
        .int()
        .min(1)
        .max(
          RECONNECT_HISTORY,
          `в снимке линии хранится не больше ${RECONNECT_HISTORY} попыток переподключения`,
        )
        .optional(),
      durationWithinPct: z
        .object({ of: kebabNameSchema, pct: z.number().positive().max(1_000) })
        .strict()
        .optional(),
    })
    .strict()
    .refine(
      (probe) =>
        probe.connected !== undefined ||
        probe.reconnectsAtLeast !== undefined ||
        probe.durationWithinPct !== undefined,
      {
        message:
          'проба линии: нужно хотя бы одно из connected, reconnectsAtLeast, durationWithinPct',
      },
    ),
  alarm: z
    .object({
      deviceCode: deviceCodeSchema,
      metricKey: z.string().min(1).optional(),
      active: z.boolean(),
    })
    .strict(),
  noAlarmsRaised: z.preprocess(
    emptyWhenNull,
    z.object({ metricKey: z.string().min(1).optional() }).strict(),
  ),
  dlqUnchanged: z
    .literal(true, { errorMap: () => ({ message: 'dlqUnchanged принимает только true' }) })
    .transform(() => ({})),
});
export type Probe = z.infer<typeof probeSchema>;
export type ProbeKind = Probe['kind'];
export type ProbeOf<K extends ProbeKind> = Extract<Probe, { kind: K }>;

/** Шаги сценария: у каждого ровно один ключ. */
export const stepSchema = oneKeyOf('шаг', {
  inject: simFaultRequestSchema
    .refine((request) => request.kind !== 'defrost', {
      message: 'оттайка не поломка со сроком: её запускает шаг simScenario: night-defrost',
      path: ['kind'],
    })
    .transform((request) => ({ request })),
  clear: z.preprocess(emptyWhenNull, simClearFaultsQuerySchema).transform((filter) => ({ filter })),
  simScenario: simScenarioNameSchema.transform((name) => ({ name })),
  baseline: z
    .object({ line: lineCodeSchema, samples: z.number().int().min(2).max(10), as: kebabNameSchema })
    .strict(),
  waitFor: z.object({ probe: probeSchema, timeoutSec: waitSecSchema }).strict(),
  hold: z.object({ probe: probeSchema, forSec: waitSecSchema }).strict(),
});
export type ScenarioStep = z.infer<typeof stepSchema>;
export type StepKind = ScenarioStep['kind'];
export type StepOf<K extends StepKind> = Extract<ScenarioStep, { kind: K }>;

/** Файл сценария стенда целиком. */
export const scenarioSchema = z
  .object({
    name: z.string().regex(KEBAB_NAME_PATTERN, 'ожидается имя в kebab-case, например dead-device'),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000),
    timeoutSec: waitSecSchema,
    steps: z.array(stepSchema).min(1, 'в сценарии нужен хотя бы один шаг'),
  })
  .strict()
  .superRefine((scenario, ctx) => {
    const declared = new Set<string>();
    let waitsSec = 0;

    scenario.steps.forEach((step, index) => {
      if (step.kind === 'baseline') {
        if (declared.has(step.as)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `базовая длительность «${step.as}» уже объявлена выше`,
            path: ['steps', index, 'baseline', 'as'],
          });
        }
        declared.add(step.as);
        return;
      }

      if (step.kind !== 'waitFor' && step.kind !== 'hold') return;

      const probe = step.probe;
      if (
        probe.kind === 'line' &&
        probe.durationWithinPct !== undefined &&
        !declared.has(probe.durationWithinPct.of)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `базовая длительность «${probe.durationWithinPct.of}» не объявлена в шагах выше`,
          path: ['steps', index, step.kind, 'probe', 'line', 'durationWithinPct', 'of'],
        });
      }

      const waitSec = step.kind === 'waitFor' ? step.timeoutSec : step.forSec;
      if (waitSec > scenario.timeoutSec) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ожидание ${waitSec} с больше общего предела сценария ${scenario.timeoutSec} с`,
          path: ['steps', index, step.kind, step.kind === 'waitFor' ? 'timeoutSec' : 'forSec'],
        });
      }
      waitsSec += waitSec;
    });

    if (waitsSec > scenario.timeoutSec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `сумма ожиданий шагов ${waitsSec} с больше общего предела ${scenario.timeoutSec} с`,
        path: ['timeoutSec'],
      });
    }
  });
export type Scenario = z.infer<typeof scenarioSchema>;
