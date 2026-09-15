import { useId } from 'react';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { EmptyState } from '../../../../../shared/ui/EmptyState/EmptyState.js';
import { ErrorState } from '../../../../../shared/ui/ErrorState/ErrorState.js';
import { SkeletonBlock } from '../../../../../shared/ui/SkeletonBlock/SkeletonBlock.js';
import type { ReplayDevices } from '../../../hooks/useReplayDevices.js';
import styles from './DevicePicker.module.scss';

interface Props {
  readonly devices: ReplayDevices;
  readonly selected: readonly string[];
  readonly disabled: boolean;
  readonly onToggle: (code: string) => void;
  readonly onSet: (codes: readonly string[]) => void;
}

/** Выбор приборов: быстрый выбор всех камер или всего стенда и отметка по одному. */
export const DevicePicker = ({
  devices,
  selected,
  disabled,
  onToggle,
  onSet,
}: Props): React.JSX.Element => {
  const titleId = useId();

  return (
    <div role="group" aria-labelledby={titleId} className={styles['picker']}>
      <div className={styles['picker__head']}>
        <Typography variant="subtitle2" component="h3" id={titleId}>
          Приборы
        </Typography>
        <Typography variant="caption" className={styles['picker__count']}>
          {`выбрано ${String(selected.length)} из ${String(devices.devices.length)}`}
        </Typography>
      </div>

      {devices.isPending ? <SkeletonBlock rows={2} height={40} label="Загружаем приборы" /> : null}

      {devices.isError && !devices.hasData ? (
        <ErrorState error={devices.error} onRetry={devices.refetch} />
      ) : null}

      {devices.hasData && devices.devices.length === 0 ? (
        <EmptyState
          title="В топологии нет приборов"
          hint="Перепрогонять не для кого: дерево объектов стенда пустое."
          actionLabel="Проверить снова"
          onAction={devices.refetch}
        />
      ) : null}

      {devices.devices.length === 0 ? null : (
        <>
          <div className={styles['picker__actions']}>
            <Button
              size="small"
              variant="outlined"
              disabled={disabled || devices.chambers.length === 0}
              onClick={() => {
                onSet(devices.chambers);
              }}
            >
              Все холодильные камеры
            </Button>
            <Button
              size="small"
              disabled={disabled}
              onClick={() => {
                onSet(devices.devices.map((device) => device.code));
              }}
            >
              Все приборы
            </Button>
            <Button
              size="small"
              disabled={disabled || selected.length === 0}
              onClick={() => {
                onSet([]);
              }}
            >
              Снять выбор
            </Button>
          </div>

          <div className={styles['picker__devices']}>
            {devices.devices.map((device) => {
              const pressed = selected.includes(device.code);

              return (
                <button
                  key={device.code}
                  type="button"
                  disabled={disabled}
                  aria-pressed={pressed}
                  className={
                    pressed
                      ? `${styles['picker__device']} ${styles['picker__device_selected']}`
                      : styles['picker__device']
                  }
                  onClick={() => {
                    onToggle(device.code);
                  }}
                >
                  <span className={styles['picker__code']}>{device.code}</span>
                  <span className={styles['picker__name']}>{device.label}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};
