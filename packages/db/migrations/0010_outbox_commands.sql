-- Up Migration
-- Очередь исходящих сообщений: команда и её публикация в брокер попадают в одну транзакцию,
-- поэтому откат транзакции не оставляет сообщения в топике. UNIQUE (aggregate_id, revision)
-- позволяет relay опубликовать повторно без последствий
CREATE TABLE core.outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  topic text NOT NULL,
  msg_key text NOT NULL,
  payload jsonb NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  lock_id uuid,
  locked_at timestamptz,
  UNIQUE (aggregate_id, revision)
);

CREATE INDEX outbox_due ON core.outbox (next_attempt_at) WHERE published_at IS NULL;

CREATE TABLE core.applied_commands (
  command_id uuid PRIMARY KEY,
  device_id integer REFERENCES core.devices (id),
  line_id smallint REFERENCES core.lines (id),
  kind text NOT NULL,
  args jsonb NOT NULL DEFAULT '{}',
  applied_at timestamptz NOT NULL,
  result jsonb NOT NULL DEFAULT '{}',
  CHECK (device_id IS NOT NULL OR line_id IS NOT NULL)
);

CREATE INDEX applied_commands_recent ON core.applied_commands (applied_at DESC);

GRANT SELECT, INSERT, UPDATE ON core.outbox TO fs_api;
-- Факт применения приходит от исполнителя через брокер, поэтому пишет его процессор,
-- а интерфейс только читает статус команды
GRANT SELECT, INSERT ON core.applied_commands TO fs_ingest;
GRANT SELECT ON core.applied_commands TO fs_api;

-- Down Migration
DROP TABLE core.applied_commands;
DROP TABLE core.outbox;
