import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { useQuery } from '@tanstack/react-query';
import type { BootStageView } from '@fieldstream/contracts';
import { api } from '../../../../shared/api/endpoints.js';
import { queryKeys } from '../../../../shared/api/query-keys.js';
import styles from './BootPanel.module.scss';

/** Пока стенд готовится, панель обновляется чаще: человек ждёт и должен видеть движение. */
const REFRESH_READY_MS = 30_000;
const REFRESH_BUSY_MS = 2_000;

const MARK: Readonly<Record<BootStageView['status'], string>> = {
  done: '✓',
  running: '…',
  pending: '·',
  failed: '×',
};

/** Состояние стадии словами: галочка и цвет остаются, но смысл держится не на них. */
const STATUS_WORD: Readonly<Record<BootStageView['status'], string>> = {
  done: 'готово',
  running: 'идёт',
  pending: 'ждёт',
  failed: 'не удалось',
};

export const BootPanel = (): React.JSX.Element | null => {
  const { data, isPending, isError } = useQuery({
    queryKey: queryKeys.boot,
    queryFn: () => api.boot(),
    refetchInterval: (query) =>
      query.state.data?.ready === true ? REFRESH_READY_MS : REFRESH_BUSY_MS,
  });

  if (isPending) {
    return (
      <Paper className={styles['boot']} elevation={0}>
        <Typography variant="subtitle2">Проверяем стенд</Typography>
        <LinearProgress />
      </Paper>
    );
  }

  if (isError) {
    return (
      <Paper className={styles['boot']} elevation={0}>
        <Typography variant="subtitle2">Стенд не отвечает</Typography>
        <Typography variant="body2" color="text.secondary">
          Шлюз недоступен. Данные появятся, как только он поднимется.
        </Typography>
      </Paper>
    );
  }

  return (
    <Paper className={styles['boot']} elevation={0}>
      <Typography variant="subtitle2">{data.ready ? 'Стенд готов' : 'Стенд готовится'}</Typography>

      <Box component="ul" className={styles['boot__stages']}>
        {data.stages.map((stage) => (
          <Box
            component="li"
            key={stage.stage}
            className={`${styles['boot__stage']} ${styles[`boot__stage_${stage.status}`] ?? ''}`}
          >
            <span className={styles['boot__mark']} aria-hidden="true">
              {MARK[stage.status]}
            </span>
            <span className={styles['boot__title']}>{stage.title}</span>
            <span className={styles['boot__status']}>{STATUS_WORD[stage.status]}</span>
            <span className={styles['boot__detail']}>{stage.detail ?? ''}</span>
          </Box>
        ))}
      </Box>

      {data.ready ? null : <LinearProgress className={styles['boot__progress']} />}
    </Paper>
  );
};
