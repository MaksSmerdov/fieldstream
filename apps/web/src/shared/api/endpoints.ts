import {
  alarmRuleAuditResponseSchema,
  alarmRulesResponseSchema,
  alarmRulesUpdateResponseSchema,
  alarmsResponseSchema,
  bootResponseSchema,
  commandAcceptedSchema,
  commandProgressSchema,
  deviceEventsResponseSchema,
  deviceProfileViewSchema,
  deviceSnapshotSchema,
  dlqListResponseSchema,
  dlqRedriveSchema,
  labFaultsResponseSchema,
  labLinesResponseSchema,
  meResponseSchema,
  pipelineResponseSchema,
  readPlanResponseSchema,
  scenarioRunSchema,
  scenariosResponseSchema,
  seriesResponseSchema,
  sessionResponseSchema,
  simClearFaultsResultSchema,
  simFaultSchema,
  topologyResponseSchema,
} from '@fieldstream/contracts';
import type {
  AlarmListItem,
  AlarmRuleAuditResponse,
  AlarmRuleUpdate,
  AlarmRulesResponse,
  AlarmRulesUpdateResponse,
  AlarmsQuery,
  AlarmsResponse,
  BootResponse,
  CommandAccepted,
  CommandProgressResponse,
  CommandRequest,
  DeviceEventsResponse,
  DeviceProfileView,
  DeviceSnapshot,
  DlqListQuery,
  DlqListResponse,
  DlqRedrive,
  LabFaultRequestInput,
  LabFaultsResponse,
  LabLinesResponse,
  MeResponse,
  PipelineResponse,
  PlanMode,
  ReadPlanResponse,
  ScenarioRun,
  ScenarioRunRequestInput,
  ScenariosResponse,
  SeriesResponse,
  SessionResponse,
  SimClearFaultsQuery,
  SimClearFaultsResult,
  SimFault,
} from '@fieldstream/contracts';
import { alarmListItemSchema } from '@fieldstream/contracts';
import { request } from './http.js';

/** Строка запроса из заданных полей: пустые значения не попадают, схемы шлюза строгие. */
const query = (params: Readonly<Record<string, string | number | undefined>>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();

  return text.length === 0 ? '' : `?${text}`;
};

export const api = {
  boot: async (): Promise<BootResponse> =>
    request('/api/boot', (value) => bootResponseSchema.parse(value), { anonymous: true }),

  login: async (email: string, password: string): Promise<SessionResponse> =>
    request('/api/auth/login', (value) => sessionResponseSchema.parse(value), {
      method: 'POST',
      body: { email, password },
      anonymous: true,
    }),

  refresh: async (): Promise<SessionResponse> =>
    request('/api/auth/refresh', (value) => sessionResponseSchema.parse(value), {
      method: 'POST',
      anonymous: true,
    }),

  logout: async (): Promise<void> =>
    request('/api/auth/logout', () => undefined, { method: 'POST', anonymous: true }),

  me: async (): Promise<MeResponse> => request('/api/me', (value) => meResponseSchema.parse(value)),

  topology: async () => request('/api/topology', (value) => topologyResponseSchema.parse(value)),

  snapshot: async (code: string): Promise<DeviceSnapshot> =>
    request(`/api/devices/${code}/latest`, (value) => deviceSnapshotSchema.parse(value)),

  profile: async (code: string): Promise<DeviceProfileView> =>
    request(`/api/devices/${code}/profile`, (value) => deviceProfileViewSchema.parse(value)),

  series: async (
    code: string,
    params: { metrics: readonly string[]; from: string; to: string; maxPoints?: number },
  ): Promise<SeriesResponse> =>
    request(
      `/api/devices/${code}/series${query({
        metrics: params.metrics.join(','),
        from: params.from,
        to: params.to,
        maxPoints: params.maxPoints,
      })}`,
      (value) => seriesResponseSchema.parse(value),
    ),

  deviceEvents: async (
    code: string,
    params: { from: string; to: string },
  ): Promise<DeviceEventsResponse> =>
    request(`/api/devices/${code}/events${query({ from: params.from, to: params.to })}`, (value) =>
      deviceEventsResponseSchema.parse(value),
    ),

  readPlan: async (code: string, mode: PlanMode): Promise<ReadPlanResponse> =>
    request(`/api/devices/${code}/read-plan${query({ mode })}`, (value) =>
      readPlanResponseSchema.parse(value),
    ),

  alarms: async (params: Partial<AlarmsQuery>): Promise<AlarmsResponse> =>
    request(
      `/api/alarms${query({
        state: params.state,
        severity: params.severity,
        device: params.device,
        from: params.from,
        to: params.to,
        cursor: params.cursor,
        limit: params.limit,
      })}`,
      (value) => alarmsResponseSchema.parse(value),
    ),

  ackAlarm: async (id: string): Promise<AlarmListItem> =>
    request(`/api/alarms/${id}/ack`, (value) => alarmListItemSchema.parse(value), {
      method: 'POST',
      body: {},
    }),

  alarmRules: async (code: string): Promise<AlarmRulesResponse> =>
    request(`/api/devices/${code}/alarm-rules`, (value) => alarmRulesResponseSchema.parse(value)),

  alarmRuleAudit: async (code: string): Promise<AlarmRuleAuditResponse> =>
    request(`/api/devices/${code}/alarm-rules/audit`, (value) =>
      alarmRuleAuditResponseSchema.parse(value),
    ),

  updateAlarmRules: async (
    code: string,
    rules: readonly AlarmRuleUpdate[],
  ): Promise<AlarmRulesUpdateResponse> =>
    request(
      `/api/devices/${code}/alarm-rules`,
      (value) => alarmRulesUpdateResponseSchema.parse(value),
      { method: 'PUT', body: { rules } },
    ),

  sendCommand: async (command: CommandRequest): Promise<CommandAccepted> =>
    request('/api/commands', (value) => commandAcceptedSchema.parse(value), {
      method: 'POST',
      body: command,
    }),

  commandProgress: async (commandId: string): Promise<CommandProgressResponse> =>
    request(`/api/commands/${commandId}`, (value) => commandProgressSchema.parse(value)),

  pipeline: async (): Promise<PipelineResponse> =>
    request('/api/pipeline', (value) => pipelineResponseSchema.parse(value)),

  dlq: async (params: Partial<DlqListQuery>): Promise<DlqListResponse> =>
    request(`/api/dlq${query({ limit: params.limit, cursor: params.cursor })}`, (value) =>
      dlqListResponseSchema.parse(value),
    ),

  redriveDlq: async (max: number): Promise<DlqRedrive> =>
    request('/api/dlq/redrive', (value) => dlqRedriveSchema.parse(value), {
      method: 'POST',
      body: { max },
    }),

  dlqRedrive: async (id: string): Promise<DlqRedrive> =>
    request(`/api/dlq/redrive/${id}`, (value) => dlqRedriveSchema.parse(value)),

  labLines: async (): Promise<LabLinesResponse> =>
    request('/api/lab/lines', (value) => labLinesResponseSchema.parse(value)),

  labFaults: async (): Promise<LabFaultsResponse> =>
    request('/api/lab/faults', (value) => labFaultsResponseSchema.parse(value)),

  injectFault: async (fault: LabFaultRequestInput): Promise<SimFault> =>
    request('/api/lab/faults', (value) => simFaultSchema.parse(value), {
      method: 'POST',
      body: fault,
    }),

  clearFaults: async (filter: SimClearFaultsQuery): Promise<SimClearFaultsResult> =>
    request(
      `/api/lab/faults${query({ targetId: filter.targetId, kind: filter.kind })}`,
      (value) => simClearFaultsResultSchema.parse(value),
      { method: 'DELETE' },
    ),

  scenarios: async (): Promise<ScenariosResponse> =>
    request('/api/scenarios', (value) => scenariosResponseSchema.parse(value)),

  runScenario: async (name: string): Promise<ScenarioRun> =>
    request(`/api/scenarios/${name}/run`, (value) => scenarioRunSchema.parse(value), {
      method: 'POST',
      body: { source: 'ui' } satisfies ScenarioRunRequestInput,
    }),

  scenarioRun: async (id: string): Promise<ScenarioRun> =>
    request(`/api/scenario-runs/${id}`, (value) => scenarioRunSchema.parse(value)),
};
