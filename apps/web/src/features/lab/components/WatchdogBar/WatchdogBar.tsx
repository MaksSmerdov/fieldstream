import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { LineStatus } from '@fieldstream/contracts';
import { durationText } from '../../lab-format.js';
import { WATCHDOG_DANGER, WATCHDOG_WARNING, watchdogView } from '../../lab-geometry.js';
import type { Tone, WatchdogTone, WatchdogView } from '../../lab-geometry.js';
import styles from './WatchdogBar.module.scss';

interface Props {
  readonly snapshot: LineStatus;
  readonly nowMs: number;
  readonly stale: boolean;
}

type ShownView = Exclude<WatchdogView, { mode: 'none' }>;

const CYCLE_NOTE: Readonly<Record<Tone, string>> = {
  normal: 'обход укладывается в предел сторожа',
  warning: 'обход подходит к пределу сторожа',
  danger: 'сторож вот-вот прервёт обход',
};

const LAST_NOTE: Readonly<Record<WatchdogTone, string>> = {
  normal: 'обход укладывается в такт опроса',
  warning: 'обход занимает большую часть такта',
  danger: 'обход занимает почти весь такт или дольше',
  offline: 'последний обход прерван: порт недоступен',
};

/** Главная строка полосы словами. */
const headline = (view: ShownView): string => {
  if (view.mode === 'last') {
    return `Последний обход: ${durationText(view.elapsedMs)} при такте ${durationText(view.limitMs)}`;
  }

  return view.frozen
    ? `Обход шёл на момент снимка: ${durationText(view.elapsedMs)} из ${durationText(view.limitMs)}`
    : `Идёт обход: ${durationText(view.elapsedMs)} из ${durationText(view.limitMs)}`;
};

/** Пояснение под полосой. */
const noteOf = (view: ShownView, snapshot: LineStatus): string => {
  if (view.mode === 'cycle') {
    return view.frozen ? 'снимок устарел: обход мог давно закончиться' : CYCLE_NOTE[view.tone];
  }

  const cycle = snapshot.lastCycle;
  const counts = cycle === null ? '' : `, опрошено ${cycle.polled}, отказов ${cycle.failed}`;

  if (view.outcome === 'watchdog') return `последний обход прервал сторож${counts}`;
  if (view.outcome === 'idle') return 'последний обход был холостым: опрашивать было некого';

  return `${LAST_NOTE[view.tone]}${counts}`;
};

/** Подпись полосы для вспомогательных программ. */
const meterLabel = (view: ShownView): string => {
  if (view.mode === 'last') return 'Длительность последнего обхода против такта';

  return view.frozen ? 'Время обхода на момент снимка' : 'Время обхода до предела сторожа';
};

/** Сторож обхода линии: прошедшее время обхода против предела с порогами цвета. */
export const WatchdogBar = ({ snapshot, nowMs, stale }: Props): React.JSX.Element => {
  const view = watchdogView(snapshot, nowMs, stale);

  return (
    <Paper variant="outlined" className={styles['watchdog']}>
      <div className={styles['watchdog__head']}>
        <Typography variant="subtitle2" component="h3">
          Сторож обхода
        </Typography>
        <Typography variant="caption" color="text.secondary" className={styles['watchdog__trips']}>
          {`срабатываний: ${snapshot.watchdog.trips}`}
        </Typography>
      </div>

      {view.mode === 'none' ? (
        <Typography variant="body2" color="text.secondary" className={styles['watchdog__empty']}>
          Обходов линии ещё не было.
        </Typography>
      ) : (
        <>
          <Typography variant="body2" className={styles['watchdog__line']}>
            {headline(view)}
          </Typography>

          <div
            className={styles['watchdog__track']}
            role="meter"
            aria-label={meterLabel(view)}
            aria-valuemin={0}
            aria-valuemax={view.limitMs}
            aria-valuenow={Math.min(view.elapsedMs, view.limitMs)}
            aria-valuetext={headline(view)}
          >
            <div
              className={styles[`watchdog__fill_${view.tone}`]}
              style={{ width: `${view.fraction * 100}%` }}
            />
            <span
              className={styles['watchdog__mark']}
              style={{ left: `${WATCHDOG_WARNING * 100}%` }}
            />
            <span
              className={styles['watchdog__mark']}
              style={{ left: `${WATCHDOG_DANGER * 100}%` }}
            />
          </div>

          <Typography variant="caption" className={styles[`watchdog__note_${view.tone}`]}>
            {noteOf(view, snapshot)}
          </Typography>
        </>
      )}
    </Paper>
  );
};
