import { useId, useState } from 'react';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import type { DlqMessage, PipelineResponse } from '@fieldstream/contracts';
import { counted, plural } from '../../../../shared/text/plural.js';
import { momentText } from '../../../../shared/time/human-time.js';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.js';
import { ErrorBanner } from '../../../../shared/ui/ErrorBanner/ErrorBanner.js';
import { ErrorState } from '../../../../shared/ui/ErrorState/ErrorState.js';
import { SkeletonBlock } from '../../../../shared/ui/SkeletonBlock/SkeletonBlock.js';
import { useDlqMessages } from '../../hooks/dlq/useDlqMessages.js';
import { numberText, topicTitle } from '../../pipeline-words.js';
import styles from './DlqMessageList.module.scss';

interface Props {
  readonly counts: PipelineResponse['dlq'];
}

type MessageState = 'waiting' | 'redriven' | 'rejected';

const STATE_TEXT: Readonly<Record<MessageState, string>> = {
  waiting: 'ждёт',
  redriven: 'возвращено',
  rejected: 'окончательно отвергнуто',
};

const STATE_COLOR: Readonly<Record<MessageState, 'warning' | 'success' | 'error'>> = {
  waiting: 'warning',
  redriven: 'success',
  rejected: 'error',
};

const ATTEMPT_FORMS: readonly [string, string, string] = ['попытка', 'попытки', 'попыток'];
const BYTE_FORMS: readonly [string, string, string] = ['байт', 'байта', 'байт'];
const MESSAGE_FORMS: readonly [string, string, string] = ['сообщение', 'сообщения', 'сообщений'];

const FAULT_FITS_CHARS = 40;
const PAYLOAD_FITS_CHARS = 24;

/** Текст строки может не поместиться на узком экране, и строку есть смысл раскрывать. */
const mayBeCut = (message: DlqMessage): boolean =>
  message.errorClass.length + 1 + message.error.length > FAULT_FITS_CHARS ||
  message.payloadPreview.length > PAYLOAD_FITS_CHARS;

/** Состояние сообщения: окончательный отказ важнее отметки о возврате. */
const stateOf = (message: DlqMessage): MessageState => {
  if (message.finalRejected) return 'rejected';

  return message.resolvedAt === null ? 'waiting' : 'redriven';
};

/** Размер тела с разрядами и склонением. */
const bytesText = (bytes: number): string => `${numberText(bytes)} ${plural(bytes, BYTE_FORMS)}`;

/**
 * Последние сообщения очереди недоставленных с подгрузкой следующих страниц. Длинный текст
 * ошибки и начало тела обрезаются, а кнопка у строки раскрывает их целиком.
 */
export const DlqMessageList = ({ counts }: Props): React.JSX.Element => {
  const messages = useDlqMessages(counts);
  const idPrefix = useId();
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = (id: string): void => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderItem = (message: DlqMessage): React.JSX.Element => {
    const state = stateOf(message);
    const fault = `${message.errorClass}: ${message.error}`;
    const open = openIds.has(message.id);
    const detailsId = `${idPrefix}-${message.id}`;
    const toggleText = open ? 'свернуть' : 'подробнее';

    return (
      <li key={message.id} className={styles['messages__item']}>
        <div className={styles['messages__head']}>
          <Chip
            size="small"
            variant="outlined"
            color={STATE_COLOR[state]}
            label={STATE_TEXT[state]}
          />
          <span className={styles['messages__moment']}>
            первая неудача {momentText(message.firstSeen)}
          </span>
          <span className={styles['messages__quiet']}>
            {counted(message.attempts, ATTEMPT_FORMS)}
          </span>
          {mayBeCut(message) ? (
            <span className={styles['messages__toggle']}>
              <Button
                size="small"
                aria-expanded={open}
                aria-controls={detailsId}
                aria-label={`${toggleText}, смещение ${message.offset}`}
                onClick={() => {
                  toggle(message.id);
                }}
              >
                {toggleText}
              </Button>
            </span>
          ) : null}
        </div>

        <div className={styles['messages__place']}>
          <span>
            {`${topicTitle(message.sourceTopic)}, партиция ${String(message.partition)}, смещение ${message.offset}`}
          </span>
          <span className={styles['messages__key']}>
            {message.key === null ? 'без ключа' : `ключ ${message.key}`}
          </span>
        </div>

        <div id={detailsId} className={styles['messages__details']}>
          <p
            className={
              open
                ? `${styles['messages__error']} ${styles['messages__error_open']}`
                : styles['messages__error']
            }
            title={fault}
          >
            <span className={styles['messages__class']}>{message.errorClass}</span>{' '}
            {message.error.length === 0 ? 'текста ошибки нет' : message.error}
          </p>

          <div className={styles['messages__body']}>
            <code
              className={
                open
                  ? `${styles['messages__payload']} ${styles['messages__payload_open']}`
                  : styles['messages__payload']
              }
              title={message.payloadPreview}
            >
              {message.payloadPreview.length === 0 ? 'тело пустое' : message.payloadPreview}
            </code>
            <span className={styles['messages__quiet']}>{bytesText(message.payloadBytes)}</span>
          </div>
        </div>
      </li>
    );
  };

  return (
    <div className={styles['messages']}>
      <Typography variant="subtitle2" component="h3">
        Последние сообщения
      </Typography>

      {messages.isError && messages.hasData ? (
        <ErrorBanner error={messages.error} onRetry={messages.refetch} />
      ) : null}

      {messages.isPending ? (
        <div className={styles['messages__viewport']}>
          <SkeletonBlock rows={4} height={96} label="Загружаем очередь недоставленных" />
        </div>
      ) : null}

      {messages.isError && !messages.hasData ? (
        <ErrorState error={messages.error} onRetry={messages.refetch} />
      ) : null}

      {messages.hasData && messages.items.length === 0 ? (
        <EmptyState
          title="Очередь пуста"
          hint="Процессору не попадалось кадров, которые он не смог разобрать. Это хорошая новость."
          actionLabel="Проверить снова"
          onAction={messages.refetch}
        />
      ) : null}

      {messages.items.length > 0 ? (
        <>
          <div
            className={styles['messages__viewport']}
            role="region"
            aria-label="Сообщения очереди недоставленных"
            tabIndex={0}
          >
            <ul className={styles['messages__list']}>{messages.items.map(renderItem)}</ul>
          </div>

          <div className={styles['messages__more']}>
            <Typography variant="caption" color="text.secondary">
              показано {counted(messages.items.length, MESSAGE_FORMS)}
            </Typography>
            {messages.hasMore ? (
              <Button size="small" onClick={messages.loadMore} disabled={messages.loadingMore}>
                {messages.loadingMore ? 'Загружаем' : 'Показать ещё'}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
};
