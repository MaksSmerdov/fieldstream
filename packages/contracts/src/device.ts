import { z } from 'zod';

/** Тип регистра Modbus: holding читается функцией 3, input функцией 4. */
export const registerTypeSchema = z.enum(['holding', 'input']);
export type RegisterType = z.infer<typeof registerTypeSchema>;

export const dataTypeSchema = z.enum(['int16', 'uint16', 'int32', 'uint32', 'float32', 'bits16']);
export type DataType = z.infer<typeof dataTypeSchema>;

/**
 * Порядок слов и байтов для 32-битных величин.
 * ABCD прямой, DCBA полный разворот, BADC обмен байтов внутри слов,
 * CDAB обмен слов (самый частый случай у промышленных контроллеров).
 */
export const byteOrderSchema = z.enum(['ABCD', 'DCBA', 'BADC', 'CDAB']);
export type ByteOrder = z.infer<typeof byteOrderSchema>;

/** Сколько регистров занимает величина данного типа. */
export const WORDS_BY_DATA_TYPE: Readonly<Record<DataType, 1 | 2>> = Object.freeze({
  int16: 1,
  uint16: 1,
  bits16: 1,
  int32: 2,
  uint32: 2,
  float32: 2,
});

export const bitSpecSchema = z.object({
  bit: z.number().int().min(0).max(15),
  key: z.string().min(1),
  label: z.string().min(1),
  invert: z.boolean().optional(),
});
export type BitSpec = z.infer<typeof bitSpecSchema>;

/**
 * Инженерный диапазон величины. Это описание прибора, а не украшение:
 * по нему симулятор строит правдоподобные значения, а проверка достоверности
 * отличает неисправность датчика от измерения.
 */
export const paramRangeSchema = z
  .object({
    min: z.number(),
    max: z.number(),
    /** Счётчик только растёт: падение означает переполнение или подмену прибора. */
    monotonic: z.boolean().default(false),
  })
  .strict();
export type ParamRange = z.infer<typeof paramRangeSchema>;

export const paramSpecSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    unit: z.string().optional(),
    address: z.number().int().min(0).max(65535),
    registerType: registerTypeSchema.default('holding'),
    dataType: dataTypeSchema,
    byteOrder: byteOrderSchema.default('ABCD'),
    scale: z.number().default(1),
    offset: z.number().default(0),
    precision: z.number().int().min(0).max(6).default(2),
    /** Расшифровка числового кода в строку состояния. */
    enum: z.record(z.string(), z.string()).optional(),
    /** Разбор слова состояния на именованные биты. */
    bits: z.array(bitSpecSchema).optional(),
    range: paramRangeSchema.optional(),
    /** Фильтр резкого скачка: значение вне maxDelta принимается только после подтверждений. */
    maxDelta: z.number().positive().optional(),
    acceptAfter: z.number().int().min(1).max(10).default(3),
  })
  .strict()
  .superRefine((param, ctx) => {
    if (param.bits && param.dataType !== 'bits16') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `параметр "${param.key}": bits допустимы только при dataType "bits16"`,
        path: ['bits'],
      });
    }
    if (param.dataType === 'bits16' && !param.bits) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `параметр "${param.key}": при dataType "bits16" нужно описать bits`,
        path: ['bits'],
      });
    }
    if (param.range && param.range.min >= param.range.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `параметр "${param.key}": range.min должен быть меньше range.max`,
        path: ['range'],
      });
    }
    if (param.enum && param.dataType === 'float32') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `параметр "${param.key}": enum несовместим с float32`,
        path: ['enum'],
      });
    }
  });
export type ParamSpec = z.infer<typeof paramSpecSchema>;

/** Явно объявленный блок чтения. Имеет приоритет над автосборкой. */
export const readBlockSchema = z
  .object({
    id: z.string().min(1),
    registerType: registerTypeSchema,
    startAddress: z.number().int().min(0).max(65535),
    registerCount: z.number().int().min(1).max(125),
  })
  .strict();
export type ReadBlock = z.infer<typeof readBlockSchema>;

export const sectionSpecSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    /** Внутренние секции вырезаются из публичного ответа API. */
    internal: z.boolean().default(false),
    params: z.array(paramSpecSchema).min(1),
  })
  .strict();
export type SectionSpec = z.infer<typeof sectionSpecSchema>;

export const deviceProfileSchema = z
  .object({
    profileKey: z.string().min(1),
    version: z.number().int().min(1),
    label: z.string().min(1),
    /** Максимум регистров в одном запросе. Ограничение протокола Modbus. */
    maxBlockRegisters: z.number().int().min(1).max(125).default(125),
    /**
     * Допустимый разрыв между соседними адресами при автосборке блока.
     * Ноль означает "только вплотную": автоблок никогда не читает регистр,
     * который не нужен ни одному параметру.
     */
    maxGapRegisters: z.number().int().min(0).max(16).default(0),
    readPlan: z
      .object({ blocks: z.array(readBlockSchema) })
      .strict()
      .optional(),
    sections: z.array(sectionSpecSchema).min(1),
  })
  .strict();
export type DeviceProfile = z.infer<typeof deviceProfileSchema>;

/** Режимы работы объекта. Уставка алармов хранится по ключу (прибор, метрика, режим). */
export const deviceModeSchema = z.enum(['cooling', 'defrost', 'service', 'off']);
export type DeviceMode = z.infer<typeof deviceModeSchema>;

/** Режимы, в которых алармы заглушены: холодная или обслуживаемая камера иначе орёт всем. */
export const MUTED_MODES: readonly DeviceMode[] = Object.freeze(['service', 'off']);
