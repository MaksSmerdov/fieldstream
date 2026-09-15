import { useId } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { SimFault, SimFaultKind, SimTargetKind } from '@fieldstream/contracts';
import { counted } from '../../../../shared/text/plural.js';
import { ErrorBanner } from '../../../../shared/ui/ErrorBanner/ErrorBanner.js';
import { ErrorState } from '../../../../shared/ui/ErrorState/ErrorState.js';
import { SkeletonBlock } from '../../../../shared/ui/SkeletonBlock/SkeletonBlock.js';
import {
  ALL_FAULTS_KEY,
  FAULT_LABEL,
  LINE_FAULTS,
  deviceFaults,
  faultKey,
} from '../../fault-kinds.js';
import { useFaultActions } from '../../hooks/faults/useFaultActions.js';
import type { FaultChange } from '../../hooks/faults/useFaultActions.js';
import { useLabFaults } from '../../hooks/faults/useLabFaults.js';
import type { LabFaults } from '../../hooks/faults/useLabFaults.js';
import type { LabTopology } from '../../hooks/useLabTopology.js';
import type { ChaosDevice, ChaosLine, Selection } from '../../lab-lines.js';
import { FaultSwitch } from '../FaultSwitch/FaultSwitch.js';
import styles from './ChaosPanel.module.scss';

interface Props {
  readonly lines: readonly ChaosLine[];
  readonly selected: Selection | null;
  readonly topology: LabTopology;
  readonly canInject: boolean;
  readonly nowMs: number;
  readonly onSelect: (code: string) => void;
}

const NO_FAULTS: readonly SimFault[] = [];

const FAULT_FORMS: readonly [string, string, string] = ['поломка', 'поломки', 'поломок'];

/** Действие словами для сообщения об отказе. */
const attemptText = (change: FaultChange): string => {
  if (change.action === 'clearAll') return 'снять все поломки';
  if (change.action === 'inject') {
    return `внести поломку «${FAULT_LABEL[change.kind]}» на ${change.targetId}`;
  }

  return `снять поломку «${FAULT_LABEL[change.kind]}» с ${change.targetId}`;
};

/** Итог удачного действия для объявления. */
const doneText = (change: FaultChange | null): string => {
  if (change === null) return '';
  if (change.action === 'clearAll') return 'Все поломки сняты';
  if (change.action === 'inject') {
    return `Поломка «${FAULT_LABEL[change.kind]}» внесена на ${change.targetId}`;
  }

  return `Поломка «${FAULT_LABEL[change.kind]}» снята с ${change.targetId}`;
};

/** Причина отказа из ответа шлюза. */
const reasonOf = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : 'причина неизвестна';

/** Сводка поломок в шапке: число только тогда, когда оно известно. */
const faultsSummary = (faults: LabFaults, count: number): string => {
  if (faults.status === 'pending') return 'Загружаем поломки';
  if (faults.status === 'unavailable' || !faults.hasData) return 'Поломки неизвестны';

  return count === 0 ? 'Действующих поломок нет' : `Действует ${counted(count, FAULT_FORMS)}`;
};

/** Панель хаоса: поломки линий и выбранного прибора, выбор прибора и снятие всех поломок. */
export const ChaosPanel = ({
  lines,
  selected,
  topology,
  canInject,
  nowMs,
  onSelect,
}: Props): React.JSX.Element => {
  const titleId = useId();
  const faults = useLabFaults();
  const actions = useFaultActions();
  const known = faults.status === 'unavailable' ? NO_FAULTS : faults.faults;
  const locked = !canInject || faults.status === 'unavailable' || !faults.hasData;
  const topologyMissing = topology.topology === undefined;

  const renderSwitch = (
    targetKind: SimTargetKind,
    targetId: string,
    kind: SimFaultKind,
    label: string,
  ): React.JSX.Element => (
    <FaultSwitch
      key={kind}
      label={label}
      active={known.find((fault) => fault.targetId === targetId && fault.kind === kind)}
      nowMs={nowMs}
      disabled={locked}
      pending={actions.pendingKeys.has(faultKey(targetId, kind))}
      onChange={(enabled) => {
        actions.change(
          enabled
            ? { action: 'inject', targetKind, targetId, kind }
            : { action: 'clear', targetId, kind },
        );
      }}
    />
  );

  const renderDevice = (device: ChaosDevice): React.JSX.Element => {
    const isSelected = selected?.device.code === device.code;
    const count = known.filter((fault) => fault.targetId === device.code).length;
    const name = device.label ?? (topology.isPending ? '' : 'имя неизвестно');

    return (
      <button
        key={device.code}
        type="button"
        className={styles[isSelected ? 'chaos__device_selected' : 'chaos__device']}
        aria-pressed={isSelected}
        onClick={() => {
          onSelect(device.code);
        }}
      >
        <span className={styles['chaos__code']}>{device.code}</span>
        <span className={styles['chaos__count']} aria-hidden="true">
          {count === 0 ? '' : count}
        </span>
        <span className={styles['chaos__name']}>{name}</span>
        {count === 0 ? null : (
          <span className={styles['chaos__hidden']}>{`, ${counted(count, FAULT_FORMS)}`}</span>
        )}
      </button>
    );
  };

  const renderTarget = (device: ChaosDevice): React.JSX.Element => {
    const modelUnknown = device.profileKey === null;

    return (
      <div className={styles['chaos__target']}>
        <Typography variant="body2" className={styles['chaos__target-title']}>
          {`Прибор ${device.code}${modelUnknown ? '' : `, модель ${device.profileKey}`}`}
        </Typography>

        {modelUnknown && topology.isPending ? (
          <SkeletonBlock rows={6} height={36} label="Загружаем модель прибора" />
        ) : (
          <div
            role="group"
            aria-label={`Поломки прибора ${device.code}`}
            className={styles['chaos__switches']}
          >
            {deviceFaults(device.profileKey).map((option) =>
              renderSwitch('device', device.code, option.kind, option.label),
            )}
          </div>
        )}

        {modelUnknown && !topology.isPending ? (
          <Typography variant="caption" color="text.secondary">
            {topology.isError && topologyMissing
              ? 'Модель прибора неизвестна: поломка «дверь не закрывается» появится, когда загрузится топология.'
              : 'Прибора нет в топологии: модель неизвестна, поломка «дверь не закрывается» недоступна.'}
          </Typography>
        ) : null}
      </div>
    );
  };

  return (
    <Paper
      variant="outlined"
      component="section"
      className={styles['chaos']}
      aria-labelledby={titleId}
    >
      <div className={styles['chaos__head']}>
        <div className={styles['chaos__title']}>
          <Typography variant="subtitle1" component="h2" id={titleId}>
            Панель хаоса
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {faultsSummary(faults, known.length)}
          </Typography>
        </div>

        <Button
          size="small"
          variant="outlined"
          color="error"
          disabled={locked || known.length === 0 || actions.pendingKeys.has(ALL_FAULTS_KEY)}
          onClick={() => {
            actions.change({ action: 'clearAll' });
          }}
        >
          Снять все
        </Button>
      </div>

      {canInject ? null : (
        <Alert severity="info" role="note" className={styles['chaos__notice']}>
          Вносить и снимать поломки может инженер. Здесь видно, какие поломки сейчас действуют.
        </Alert>
      )}

      {faults.status === 'unavailable' ? (
        <Alert severity="warning" role="status" className={styles['chaos__notice']}>
          Шлюз не видит симулятор стенда: поломки сейчас не прочитать и не внести. Приборы защиты
          сборщика при этом работают.
        </Alert>
      ) : null}

      {faults.status === 'error' && !faults.hasData ? (
        <ErrorState error={faults.error} onRetry={faults.refetch} />
      ) : null}

      {faults.status === 'error' && faults.hasData ? (
        <ErrorBanner error={faults.error} onRetry={faults.refetch} />
      ) : null}

      {topology.isError && topologyMissing ? (
        <ErrorBanner error={topology.error} onRetry={topology.refetch} />
      ) : null}

      {actions.failures.map((failure) => (
        <Alert
          key={failure.key}
          severity="error"
          role="alert"
          className={styles['chaos__notice']}
          onClose={() => {
            actions.dismiss(failure.key);
          }}
        >
          {`Не удалось ${attemptText(failure.change)}: ${reasonOf(failure.error)}`}
        </Alert>
      ))}

      <p className={styles['chaos__hidden']} role="status" aria-live="polite">
        {doneText(actions.done)}
      </p>

      {lines.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Линий пока нет: ни топология, ни сборщик их ещё не показали.
        </Typography>
      ) : null}

      {lines.map((line) => (
        <section
          key={line.code}
          className={styles['chaos__line']}
          aria-label={`Линия ${line.code}`}
        >
          <Typography variant="subtitle2" component="h3">
            {`Линия ${line.code}`}
          </Typography>

          <div
            role="group"
            aria-label={`Поломки линии ${line.code}`}
            className={styles['chaos__switches']}
          >
            {LINE_FAULTS.map((option) =>
              renderSwitch('line', line.code, option.kind, option.label),
            )}
          </div>

          {line.devices.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              Приборов на линии нет.
            </Typography>
          ) : (
            <div className={styles['chaos__devices']}>{line.devices.map(renderDevice)}</div>
          )}

          {selected !== null && selected.line.code === line.code
            ? renderTarget(selected.device)
            : null}
        </section>
      ))}
    </Paper>
  );
};
