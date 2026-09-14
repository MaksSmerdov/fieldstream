import { z } from 'zod';
import { isoTimestampSchema } from '../primitives.js';

const countSchema = z.number().int().min(0);

/** Партиция топика: начало и конец лога. */
export const pipelinePartitionSchema = z
  .object({ partition: countSchema, low: countSchema, high: countSchema })
  .strict();
export type PipelinePartition = z.infer<typeof pipelinePartitionSchema>;

/** Топик из манифеста с темпом поступления по приросту конца лога. */
export const pipelineTopicSchema = z
  .object({
    name: z.string().min(1),
    owner: z.string().min(1),
    cleanupPolicy: z.enum(['delete', 'compact']),
    partitions: z.array(pipelinePartitionSchema),
    messagesPerSec: z.number().min(0).nullable(),
  })
  .strict();
export type PipelineTopic = z.infer<typeof pipelineTopicSchema>;

/** Отставание группы на партиции: подтверждённое смещение против конца лога. */
export const pipelineLagSchema = z
  .object({
    topic: z.string().min(1),
    partition: countSchema,
    committed: countSchema.nullable(),
    high: countSchema,
    lag: countSchema.nullable(),
    memberId: z.string().min(1).nullable(),
  })
  .strict();
export type PipelineLag = z.infer<typeof pipelineLagSchema>;

export const pipelineMemberSchema = z
  .object({
    memberId: z.string().min(1),
    clientId: z.string(),
    host: z.string(),
    assignments: z.array(
      z.object({ topic: z.string().min(1), partitions: z.array(countSchema) }).strict(),
    ),
  })
  .strict();
export type PipelineMember = z.infer<typeof pipelineMemberSchema>;

/** Группа потребителей: участники, раскладка партиций и отставание. */
export const pipelineGroupSchema = z
  .object({
    groupId: z.string().min(1),
    state: z.string().min(1),
    members: z.array(pipelineMemberSchema),
    lag: z.array(pipelineLagSchema),
    totalLag: countSchema,
    lagSeconds: z.number().min(0).nullable(),
  })
  .strict();
export type PipelineGroup = z.infer<typeof pipelineGroupSchema>;

/** Замеченная смена состава или раскладки группы. */
export const pipelineRebalanceSchema = z
  .object({
    groupId: z.string().min(1),
    at: isoTimestampSchema,
    membersBefore: countSchema,
    membersAfter: countSchema,
  })
  .strict();
export type PipelineRebalance = z.infer<typeof pipelineRebalanceSchema>;

export const pipelineResponseSchema = z
  .object({
    serverTime: isoTimestampSchema,
    sampledAt: isoTimestampSchema.nullable(),
    brokerError: z.string().nullable(),
    topics: z.array(pipelineTopicSchema),
    groups: z.array(pipelineGroupSchema),
    rebalances: z.array(pipelineRebalanceSchema).max(50),
    dlq: z.object({ unresolved: countSchema, total: countSchema }).strict(),
    live: z.object({ streams: countSchema, eventsPerSec: z.number().min(0) }).strict(),
  })
  .strict();
export type PipelineResponse = z.infer<typeof pipelineResponseSchema>;
