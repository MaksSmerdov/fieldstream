import { z } from 'zod';
import { isoTimestampSchema } from '../primitives.js';
import { moduleIdSchema, roleSchema } from './permissions.js';

export const loginRequestSchema = z
  .object({
    email: z.string().email().max(200),
    password: z.string().min(8).max(200),
  })
  .strict();
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Пользователь так, как его видит интерфейс: роль отдельно, действующие права отдельно. */
export const sessionUserSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string().min(1),
    role: roleSchema,
    permissions: z.array(moduleIdSchema),
  })
  .strict();
export type SessionUser = z.infer<typeof sessionUserSchema>;

/** Ответ входа и обновления. Токен обновления уходит отдельной cookie и в теле не появляется. */
export const sessionResponseSchema = z
  .object({
    accessToken: z.string().min(1),
    expiresAt: isoTimestampSchema,
    user: sessionUserSchema,
  })
  .strict();
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const meResponseSchema = z
  .object({
    user: sessionUserSchema,
    serverTime: isoTimestampSchema,
  })
  .strict();
export type MeResponse = z.infer<typeof meResponseSchema>;
