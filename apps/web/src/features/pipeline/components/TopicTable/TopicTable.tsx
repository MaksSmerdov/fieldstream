import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { PipelineTopic } from '@fieldstream/contracts';
import { logMessages } from '../../pipeline-geometry.js';
import { CLEANUP_WORDS, numberText, rateValue, topicTitle } from '../../pipeline-words.js';
import styles from './TopicTable.module.scss';

interface Props {
  readonly topics: readonly PipelineTopic[];
}

/** Таблица топиков: владелец, политика очистки, партиции, темп и объём лога. */
export const TopicTable = ({ topics }: Props): React.JSX.Element => (
  <Paper variant="outlined" component="section" aria-label="Топики" className={styles['topics']}>
    <Typography variant="subtitle1" component="h2" className={styles['topics__heading']}>
      Топики
    </Typography>

    {topics.length === 0 ? (
      <Typography variant="body2" className={styles['topics__empty']}>
        В снимке брокера топиков нет: шлюз ещё не получил ответ брокера.
      </Typography>
    ) : (
      <div
        className={styles['topics__scroll']}
        role="region"
        aria-label="Таблица топиков"
        tabIndex={0}
      >
        <table className={styles['topics__table']}>
          <thead>
            <tr>
              <th scope="col" className={styles['topics__name']}>
                Топик
              </th>
              <th scope="col">Владелец</th>
              <th scope="col">Очистка</th>
              <th scope="col" className={styles['topics__number']}>
                Партиций
              </th>
              <th scope="col" className={styles['topics__number']}>
                Сообщений в секунду
              </th>
              <th scope="col" className={styles['topics__number']}>
                Сообщений в логе
              </th>
            </tr>
          </thead>
          <tbody>
            {topics.map((topic) => (
              <tr key={topic.name}>
                <th scope="row" className={styles['topics__name']}>
                  <span className={styles['topics__title']}>{topicTitle(topic.name)}</span>
                  <span className={styles['topics__machine']}>{topic.name}</span>
                </th>
                <td>{topic.owner}</td>
                <td>{CLEANUP_WORDS[topic.cleanupPolicy]}</td>
                <td className={styles['topics__number']}>{topic.partitions.length}</td>
                <td className={styles['topics__number']}>{rateValue(topic.messagesPerSec)}</td>
                <td className={styles['topics__number']}>
                  {numberText(logMessages(topic.partitions))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </Paper>
);
