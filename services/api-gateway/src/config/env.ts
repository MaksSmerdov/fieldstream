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
  /** Из одного секрета выводятся ключ подписи токена доступа и перец для хеша токена обновления. */
  AUTH_SECRET: z.string().min(32, 'секрет обязателен и не короче 32 символов'),
  ACCESS_TTL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(600_000),
  REFRESH_TTL_MS: z.coerce.number().int().min(3_600_000).default(2_592_000_000),
  /** Окно повтора: ответ на обновление мог потеряться по дороге, это не повод разлогинивать. */
  REFRESH_REUSE_WINDOW_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
  LOGIN_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(10),
  /** Ведро адреса шире ведра почты: за одним адресом может сидеть целая площадка. */
  LOGIN_IP_ATTEMPTS: z.coerce.number().int().min(1).max(1_000).default(50),
  LOGIN_REFILL_MS: z.coerce.number().int().min(1_000).default(30_000),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * Доверять заголовкам обратного прокси. За nginx адрес запроса это адрес прокси: без доверия
   * все входы попадают в одно ведро ограничителя. Включать только со своим прокси.
   */
  TRUST_PROXY: z
    .enum(['on', 'off'])
    .default('off')
    .transform((value) => value === 'on'),
  SSE_PING_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  /** Мост из брокера в живой канал. Выключается там, где шлюз поднимают без Kafka. */
  SSE_BRIDGE: z.enum(['on', 'off']).default('on'),
  /** Рассылка очереди исходящих. Выключается там, где шлюз поднимают без брокера. */
  OUTBOX_RELAY: z.enum(['on', 'off']).default('on'),
  OUTBOX_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(500),
  OUTBOX_BATCH: z.coerce.number().int().min(1).max(500).default(100),
  /** Срок жизни команды: применять её позже смысла нет, обстановка уже другая. */
  COMMAND_TTL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
  SSE_RING_SIZE: z.coerce.number().int().min(100).max(50_000).default(5_000),
  PIPELINE_SAMPLER: z.enum(['on', 'off']).default('on'),
  PIPELINE_POLL_MS: z.coerce.number().int().min(500).max(60_000).default(2_000),
  COLLECTOR_STATUS: z.enum(['on', 'off']).default('on'),
  SIM_URL: z.string().url().optional(),
  SCENARIOS_DIR: z.string().min(1).optional(),
  SCENARIO_POLL_MS: z.coerce.number().int().min(50).max(10_000).default(1_000),
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
