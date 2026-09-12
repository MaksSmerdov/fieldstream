import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AlarmRuleAuditEntry,
  AlarmRuleUpdate,
  AlarmRuleView,
  AlarmRulesUpdateResponse,
} from '@fieldstream/contracts';
import { api } from '../../../shared/api/endpoints.js';
import { queryKeys } from '../../../shared/api/query-keys.js';

export interface AlarmRulesScreen {
  readonly rules: readonly AlarmRuleView[];
  readonly audit: readonly AlarmRuleAuditEntry[];
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
  readonly save: (updates: readonly AlarmRuleUpdate[]) => void;
  readonly saving: boolean;
  readonly saveError: unknown;
  readonly saved: AlarmRulesUpdateResponse | undefined;
}

/**
 * Уставки прибора и журнал их правок. Ответ на правку уже несёт новые значения, поэтому
 * список обновляется из него же: лишний запрос только добавил бы окно, в котором на экране
 * старые числа.
 */
export const useAlarmRules = (code: string): AlarmRulesScreen => {
  const client = useQueryClient();

  const rules = useQuery({
    queryKey: queryKeys.alarmRules(code),
    queryFn: () => api.alarmRules(code),
  });
  const audit = useQuery({
    queryKey: queryKeys.alarmRuleAudit(code),
    queryFn: () => api.alarmRuleAudit(code),
  });

  const mutation = useMutation({
    mutationFn: (updates: readonly AlarmRuleUpdate[]) => api.updateAlarmRules(code, updates),
    onSuccess: (response) => {
      client.setQueryData(queryKeys.alarmRules(code), {
        deviceCode: code,
        rules: response.rules,
      });
      void client.invalidateQueries({ queryKey: queryKeys.alarmRuleAudit(code) });
    },
  });

  return {
    rules: rules.data?.rules ?? [],
    audit: audit.data?.items ?? [],
    isPending: rules.isPending || audit.isPending,
    isError: rules.isError || audit.isError,
    error: rules.error ?? audit.error,
    refetch: () => {
      void rules.refetch();
      void audit.refetch();
    },
    save: (updates) => {
      mutation.mutate(updates);
    },
    saving: mutation.isPending,
    saveError: mutation.error,
    saved: mutation.data,
  };
};
