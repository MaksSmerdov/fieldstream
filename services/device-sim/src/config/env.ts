import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);

const envSchema = z.object({
  SIM_SEED: z.string().min(1).default('fieldstream'),
  SIM_HOST: z.string().min(1).default('0.0.0.0'),
  SIM_HTTP_PORT: port.default(8090),
  SIM_SPEED: z.coerce.number().min(1).max(60).default(1),
  SIM_TURNAROUND_MS: z.coerce.number().int().min(0).max(1000).default(5),
  SIM_BUS_TIMEOUT_MS: z.coerce.number().int().min(0).max(10_000).default(500),
  SIM_STALL_MS: z.coerce.number().int().min(0).max(60_000).default(5000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

/** Разбор окружения при старте: неверная переменная роняет сервис со списком причин. */
export const loadEnv = (source: Readonly<Record<string, string | undefined>>): Env => {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) return parsed.data;

  const lines = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`device-sim: неверное окружение\n${lines.join('\n')}`);
};
