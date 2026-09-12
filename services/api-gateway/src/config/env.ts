import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);

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
  KAFKA_CLIENT_ID: z.string().min(1).default('api-gateway'),
  DATABASE_HOST: z.string().min(1).default('localhost'),
  DATABASE_PORT: port.default(5432),
  POSTGRES_DB: z.string().min(1).default('fieldstream'),
  FS_API_PASSWORD: z.string().min(1, 'пароль обязателен, значения по умолчанию нет'),
  GATEWAY_HOST: z.string().min(1).default('0.0.0.0'),
  GATEWAY_HTTP_PORT: port.default(8093),
  /** Экземпляр шлюза: входит в группу потребителей и в идентификаторы событий. */
  GATEWAY_INSTANCE_ID: z.string().min(1).optional(),
  CORS_ORIGINS: list.default('http://localhost:5173'),
  SSE_PING_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  SSE_RING_SIZE: z.coerce.number().int().min(100).max(50_000).default(5_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

/** Разбор окружения при старте: неверная или пропущенная переменная роняет сервис со списком причин. */
export const loadEnv = (source: Readonly<Record<string, string | undefined>>): Env => {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) return parsed.data;

  const lines = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`api-gateway: неверное окружение\n${lines.join('\n')}`);
};
