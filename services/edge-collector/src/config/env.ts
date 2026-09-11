import { z } from 'zod';

/** Пустая строка из файла окружения означает «не задано». */
const optionalText = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

const list = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

const envSchema = z.object({
  KAFKA_BROKERS: list.default('localhost:29092'),
  KAFKA_CLIENT_ID: z.string().min(1).default('edge-collector'),
  MODBUS_HOST_OVERRIDE: optionalText,
  COLLECTOR_LINES: z.preprocess((value) => (value === '' ? undefined : value), list.optional()),
  COLLECTOR_HOST: z.string().min(1).default('0.0.0.0'),
  COLLECTOR_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8091),
  COLLECTOR_BUFFER_CAPACITY: z.coerce.number().int().min(100).max(1_000_000).default(2_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

/** Разбор окружения при старте: неверная переменная роняет сервис со списком причин. */
export const loadEnv = (source: Readonly<Record<string, string | undefined>>): Env => {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) return parsed.data;

  const lines = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`edge-collector: неверное окружение\n${lines.join('\n')}`);
};
