import { useEffect, useRef, useState } from 'react';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useSearchParams } from 'react-router-dom';
import { hasPermission } from '@fieldstream/contracts';
import type { AlarmStateFilter, Severity } from '@fieldstream/contracts';
import { AlarmFilters } from '../features/alarms/components/AlarmFilters/AlarmFilters.js';
import type { FeedFilters } from '../features/alarms/components/AlarmFilters/AlarmFilters.js';
import { AlarmList } from '../features/alarms/components/AlarmList/AlarmList.js';
import { useAckAlarm } from '../features/alarms/hooks/useAckAlarm.js';
import { useAlarmFeed } from '../features/alarms/hooks/useAlarmFeed.js';
import { useDeviceCodes } from '../features/alarms/hooks/useDeviceCodes.js';
import { useSessionStore } from '../shared/auth/session-store.js';
import { counted } from '../shared/text/plural.js';
import { EmptyState } from '../shared/ui/EmptyState/EmptyState.js';
import { ErrorBanner } from '../shared/ui/ErrorBanner/ErrorBanner.js';
import { ErrorState } from '../shared/ui/ErrorState/ErrorState.js';
import { SkeletonBlock } from '../shared/ui/SkeletonBlock/SkeletonBlock.js';
import styles from './AlarmsPage.module.scss';

const STATES: readonly AlarmStateFilter[] = ['any', 'active', 'cleared'];
const SEVERITIES: readonly Severity[] = ['info', 'warning', 'critical'];

/** Фильтры читаются из адреса: чужая ссылка должна открывать ровно то же, что видел отправитель. */
const filtersOf = (params: URLSearchParams): FeedFilters => {
  const state = params.get('state') ?? 'any';
  const severity = params.get('severity') ?? 'all';

  return {
    state: STATES.includes(state as AlarmStateFilter) ? (state as AlarmStateFilter) : 'any',
    severity: SEVERITIES.includes(severity as Severity) ? (severity as Severity) : 'all',
    device: params.get('device') ?? '',
  };
};

/** Лента и история алармов: фильтры в адресе, страницы курсором, подтверждение без ожидания. */
export const AlarmsPage = (): React.JSX.Element => {
  const [params, setParams] = useSearchParams();
  const [announcement, setAnnouncement] = useState('');
  const filters = filtersOf(params);
  const devices = useDeviceCodes();
  const permissions = useSessionStore((state) => state.user?.permissions);
  const canAck = hasPermission(permissions ?? [], 'alarms.ack');

  const feed = useAlarmFeed({
    state: filters.state,
    ...(filters.severity === 'all' ? {} : { severity: filters.severity }),
    ...(filters.device === '' ? {} : { device: filters.device }),
  });
  const { ack, pendingId, error: ackError } = useAckAlarm();

  /**
   * Новый эпизод приезжает живым каналом: экран с лентой обязан сказать о нём вслух.
   * Смена фильтра приносит другой набор строк, и без привязки к фильтру первая строка
   * нового набора объявлялась бы как только что случившийся аларм.
   */
  const filterKey = `${filters.state}|${filters.severity}|${filters.device}`;
  const top = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    const first = feed.items[0];
    if (first === undefined) return;

    const previous = top.current;
    top.current = { key: filterKey, id: first.id };
    if (previous === null || previous.key !== filterKey || previous.id === first.id) return;
    if (first.active) setAnnouncement(`новый аларм: ${first.deviceCode}, ${first.metricKey}`);
  }, [feed.items, filterKey]);

  const change = (next: Partial<FeedFilters>): void => {
    const merged = { ...filters, ...next };
    const search = new URLSearchParams();
    if (merged.state !== 'any') search.set('state', merged.state);
    if (merged.severity !== 'all') search.set('severity', merged.severity);
    if (merged.device !== '') search.set('device', merged.device);
    setParams(search, { replace: true });
  };

  return (
    <>
      <Typography variant="h5" gutterBottom>
        Алармы
      </Typography>

      <AlarmFilters value={filters} devices={devices} onChange={change} />

      <p className={styles['alarms__announcer']} role="status" aria-live="polite">
        {announcement}
      </p>

      {ackError === null ? null : <ErrorState error={ackError} />}

      {feed.isPending ? <SkeletonBlock rows={8} height={44} label="Загружаем ленту" /> : null}

      {feed.isError && !feed.hasData ? (
        <ErrorState error={feed.error} onRetry={feed.refetch} />
      ) : null}

      {feed.isError && feed.hasData ? (
        <ErrorBanner error={feed.error} onRetry={feed.refetch} />
      ) : null}

      {!feed.isPending && feed.hasData && feed.items.length === 0 ? (
        <EmptyState
          title="Под фильтры ничего не попало"
          hint="Смените состояние или важность: за выбранным прибором эпизодов может не быть вовсе."
          actionLabel="Сбросить фильтры"
          onAction={() => {
            change({ state: 'any', severity: 'all', device: '' });
          }}
        />
      ) : null}

      {!feed.isPending && feed.items.length > 0 ? (
        <>
          <AlarmList items={feed.items} canAck={canAck} pendingId={pendingId} onAck={ack} />

          <div className={styles['alarms__more']}>
            <Typography variant="caption" color="text.secondary">
              показано {counted(feed.items.length, ['эпизод', 'эпизода', 'эпизодов'])}
            </Typography>
            {feed.hasMore ? (
              <Button size="small" onClick={feed.loadMore} disabled={feed.loadingMore}>
                {feed.loadingMore ? 'Загружаем' : 'Показать ещё'}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
};
