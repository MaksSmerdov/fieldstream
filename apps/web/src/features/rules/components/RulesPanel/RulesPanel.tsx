import Alert from '@mui/material/Alert';
import { hasPermission } from '@fieldstream/contracts';
import { useSessionStore } from '../../../../shared/auth/session-store.js';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.js';
import { ErrorState } from '../../../../shared/ui/ErrorState/ErrorState.js';
import { SkeletonBlock } from '../../../../shared/ui/SkeletonBlock/SkeletonBlock.js';
import { counted } from '../../../../shared/text/plural.js';
import { useAlarmRules } from '../../hooks/useAlarmRules.js';
import { RulesAudit } from '../RulesAudit/RulesAudit.js';
import { RulesTable } from '../RulesTable/RulesTable.js';
import styles from './RulesPanel.module.scss';

interface Props {
  readonly code: string;
  readonly labels: Readonly<Record<string, string>>;
}

/** Уставки и след их правок рядом: правка без видимого следа это ровно то, чего быть не должно. */
export const RulesPanel = ({ code, labels }: Props): React.JSX.Element => {
  const permissions = useSessionStore((state) => state.user?.permissions);
  const editable = hasPermission(permissions ?? [], 'alarm-rules.edit');
  const screen = useAlarmRules(code);

  if (screen.isPending) return <SkeletonBlock rows={5} height={44} label="Загружаем уставки" />;

  if (screen.isError) return <ErrorState error={screen.error} onRetry={screen.refetch} />;

  if (screen.rules.length === 0) {
    return (
      <EmptyState
        title="Уставок у прибора нет"
        hint="Их заводит мигратор из набора по умолчанию при запуске стека."
        actionLabel="Проверить снова"
        onAction={screen.refetch}
      />
    );
  }

  return (
    <div className={styles['panel']}>
      {screen.saveError === null ? null : (
        <ErrorState error={screen.saveError} onRetry={screen.refetch} />
      )}

      {screen.saved === undefined || screen.saved.changes.length === 0 ? null : (
        <Alert severity="success" className={styles['panel__done']}>
          Сохранено {counted(screen.saved.changes.length, ['уставка', 'уставки', 'уставок'])}.
          Процессор подхватит их в ближайшие секунды.
        </Alert>
      )}

      <RulesTable
        rules={screen.rules}
        labels={labels}
        editable={editable}
        saving={screen.saving}
        onSave={screen.save}
      />

      <RulesAudit items={screen.audit} labels={labels} />
    </div>
  );
};
