import type { AlarmsQuery, PlanMode, ReplayEpisodesQuery } from '@fieldstream/contracts';

/**
 * Ключи кэша в одном месте. Живые события патчат кэш по этим же ключам, поэтому расхождение
 * ключа в двух файлах означало бы тихо не обновляющийся экран.
 */
export const queryKeys = {
  boot: ['boot'] as const,
  me: ['me'] as const,
  topology: ['topology'] as const,
  snapshot: (code: string) => ['device', code, 'snapshot'] as const,
  profile: (code: string) => ['device', code, 'profile'] as const,
  series: (code: string, metrics: readonly string[], from: string, to: string) =>
    ['device', code, 'series', metrics.join(','), from, to] as const,
  deviceEvents: (code: string, from: string, to: string) =>
    ['device', code, 'events', from, to] as const,
  readPlan: (code: string, mode: PlanMode) => ['device', code, 'read-plan', mode] as const,
  alarmRules: (code: string) => ['device', code, 'alarm-rules'] as const,
  alarmRuleAudit: (code: string) => ['device', code, 'alarm-rules', 'audit'] as const,
  alarms: (params: Partial<AlarmsQuery>) =>
    [
      'alarms',
      params.state ?? 'any',
      params.severity ?? 'all',
      params.device ?? 'all',
      params.limit ?? 50,
    ] as const,
  pipeline: ['pipeline'] as const,
  dlqMessages: ['dlq', 'messages'] as const,
  dlqRedrive: (id: string) => ['dlq', 'redrive', id] as const,
  labLines: ['lab', 'lines'] as const,
  labFaults: ['lab', 'faults'] as const,
  scenarios: ['lab', 'scenarios'] as const,
  scenarioRun: (id: string) => ['lab', 'scenario-runs', id] as const,
  replayRuns: ['replay', 'runs'] as const,
  replayRun: (id: string) => ['replay', 'run', id] as const,
  replayDiff: (id: string) => ['replay', 'run', id, 'diff'] as const,
  replayEpisodes: (id: string, row: ReplayEpisodesQuery) =>
    ['replay', 'run', id, 'episodes', row.deviceCode, row.metricKey, row.mode] as const,
};
