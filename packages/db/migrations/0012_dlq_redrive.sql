-- Up Migration
-- Запросы повторной подачи из очереди недоставленных: интерфейс кладёт запрос, процессор
-- забирает его и возвращает сообщения в исходный топик. Писатель сообщений один, это процессор
CREATE TABLE core.dlq_redrive (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requested_by text NOT NULL,
  max_messages integer NOT NULL CHECK (max_messages BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  redriven integer NOT NULL DEFAULT 0 CHECK (redriven >= 0),
  rejected integer NOT NULL DEFAULT 0 CHECK (rejected >= 0),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX dlq_redrive_queued ON core.dlq_redrive (id) WHERE status = 'queued';
CREATE INDEX dlq_message_pending ON core.dlq_message (id)
  WHERE resolved_at IS NULL AND NOT final_rejected;

ALTER TABLE core.dlq_message ADD COLUMN redrive_of bigint;
CREATE UNIQUE INDEX dlq_message_redrive_of ON core.dlq_message (redrive_of)
  WHERE redrive_of IS NOT NULL;

GRANT SELECT ON core.dlq_redrive TO fs_api;
GRANT INSERT (requested_by, max_messages) ON core.dlq_redrive TO fs_api;
GRANT SELECT, UPDATE ON core.dlq_redrive TO fs_ingest;

-- Down Migration
DROP INDEX core.dlq_message_redrive_of;
ALTER TABLE core.dlq_message DROP COLUMN redrive_of;
DROP INDEX core.dlq_message_pending;
DROP TABLE core.dlq_redrive;
