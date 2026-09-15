import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { PipelineGroup, PipelineLag, PipelineTopic } from '@fieldstream/contracts';
import { counted } from '../../../../shared/text/plural.js';
import { memberTones, partitionBarShape } from '../../pipeline-geometry.js';
import {
  groupStateColor,
  groupStateText,
  isRebalancingState,
  lagSecondsText,
  memberName,
  numberText,
  topicTitle,
} from '../../pipeline-words.js';
import { PartitionBar } from '../PartitionBar/PartitionBar.js';
import styles from './GroupCard.module.scss';

interface Props {
  readonly group: PipelineGroup;
  readonly topics: readonly PipelineTopic[];
}

/** Состояние строки партиции словами. */
const lagText = (row: PipelineLag, low: number): string => {
  const { emptyLog, place } = partitionBarShape(low, row.high, row.committed);
  const empty = emptyLog ? 'лог пуст, ' : '';

  if (row.committed === null) return `${empty}коммита не было`;
  if (place === 'after-log') return `${empty}коммит впереди конца лога`;

  const lag =
    row.lag === null || row.lag === 0 ? 'отставания нет' : `отставание ${numberText(row.lag)}`;

  return place === 'before-log' ? `${empty}${lag}, часть лога удалена до чтения` : `${empty}${lag}`;
};

/** Строки отставания по топикам в порядке ответа. */
const byTopic = (rows: readonly PipelineLag[]): [string, PipelineLag[]][] => {
  const grouped = new Map<string, PipelineLag[]>();
  for (const row of rows) grouped.set(row.topic, [...(grouped.get(row.topic) ?? []), row]);

  return [...grouped];
};

/** Карточка группы потребителей: состояние, участники и отставание по партициям. */
export const GroupCard = ({ group, topics }: Props): React.JSX.Element => {
  const tones = memberTones(group.members);
  const names = new Map(group.members.map((member) => [member.memberId, memberName(member)]));
  const lows = new Map(
    topics.flatMap((topic) =>
      topic.partitions.map((item) => [`${topic.name}#${String(item.partition)}`, item.low]),
    ),
  );
  const rebalancing = isRebalancingState(group.state);

  return (
    <Paper
      variant="outlined"
      component="section"
      aria-label={`Группа ${group.groupId}`}
      className={styles['card']}
    >
      <div className={styles['card__head']}>
        <Typography variant="subtitle1" component="h3" className={styles['card__id']}>
          {group.groupId}
        </Typography>
        <Chip
          size="small"
          variant="outlined"
          color={groupStateColor(group.state)}
          label={groupStateText(group.state)}
        />
      </div>

      <div className={styles['card__facts']}>
        <span className={styles['card__lag']}>
          суммарное отставание {numberText(group.totalLag)}
        </span>
        <span className={styles['card__quiet']}>
          {lagSecondsText(group.totalLag, group.lagSeconds)}
        </span>
      </div>

      {group.members.length === 0 ? (
        <Typography variant="body2" className={styles['card__quiet']}>
          {rebalancing
            ? 'Участники перераспределяют партиции: раскладки пока нет.'
            : 'Участников нет: ни один экземпляр не подключён к группе.'}
        </Typography>
      ) : (
        <ul className={styles['card__members']} aria-label="Участники группы">
          {group.members.map((member) => (
            <li key={member.memberId} className={styles['card__member']}>
              <span
                className={`${styles['card__swatch']} ${styles[`card__swatch_tone${String(tones.get(member.memberId) ?? 0)}`]}`}
                aria-hidden="true"
              />
              <span className={styles['card__client']}>{memberName(member)}</span>
              <span className={styles['card__quiet']}>{member.host}</span>
              <span className={styles['card__assigned']}>
                {member.assignments.length === 0
                  ? 'партиций не назначено'
                  : member.assignments
                      .map(
                        (assignment) =>
                          `${topicTitle(assignment.topic)}: ${assignment.partitions.join(', ')}`,
                      )
                      .join('; ')}
              </span>
            </li>
          ))}
        </ul>
      )}

      {group.lag.length === 0 ? (
        <Typography variant="body2" className={styles['card__quiet']}>
          Смещений группа ещё не подтверждала.
        </Typography>
      ) : (
        byTopic(group.lag).map(([topic, rows]) => (
          <div key={topic} className={styles['card__topic']}>
            <Typography variant="caption" component="h4" className={styles['card__caption']}>
              {topicTitle(topic)} · {counted(rows.length, ['партиция', 'партиции', 'партиций'])}
            </Typography>

            <ul className={styles['card__rows']}>
              {rows.map((row) => {
                const low = lows.get(`${row.topic}#${String(row.partition)}`) ?? 0;
                const tone = row.memberId === null ? null : (tones.get(row.memberId) ?? null);

                return (
                  <li
                    key={`${row.topic}#${String(row.partition)}`}
                    className={styles['card__row']}
                    data-partition={`${row.topic}#${String(row.partition)}`}
                  >
                    <span className={styles['card__partition']}>партиция {row.partition}</span>
                    <span
                      className={
                        row.memberId === null
                          ? `${styles['card__owner']} ${styles['card__owner_none']}`
                          : styles['card__owner']
                      }
                    >
                      {row.memberId === null
                        ? rebalancing
                          ? 'ждёт назначения'
                          : 'без участника'
                        : (names.get(row.memberId) ?? row.memberId)}
                    </span>
                    <span className={styles['card__status']}>{lagText(row, low)}</span>
                    <span className={styles['card__bar']}>
                      <PartitionBar
                        partition={row.partition}
                        low={low}
                        high={row.high}
                        committed={row.committed}
                        lag={row.lag}
                        tone={tone}
                      />
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </Paper>
  );
};
