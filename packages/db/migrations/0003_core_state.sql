-- Up Migration
CREATE TABLE core.device_state (
  device_id integer PRIMARY KEY REFERENCES core.devices (id),
  status text NOT NULL CHECK (status IN ('online', 'degraded', 'offline', 'unknown')),
  reason text NOT NULL,
  since timestamptz NOT NULL,
  mode text NOT NULL CHECK (mode IN ('cooling', 'defrost', 'service', 'off')),
  last_ok_at timestamptz,
  consecutive_errors integer NOT NULL DEFAULT 0 CHECK (consecutive_errors >= 0),
  updated_at timestamptz NOT NULL
);

CREATE TABLE core.device_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id integer NOT NULL REFERENCES core.devices (id),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL,
  UNIQUE (device_id, kind, occurred_at)
);

CREATE INDEX device_events_recent ON core.device_events (device_id, occurred_at DESC);

CREATE TABLE core.dlq_message (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_topic text NOT NULL,
  partition integer NOT NULL,
  "offset" bigint NOT NULL,
  key text,
  headers jsonb NOT NULL DEFAULT '{}',
  payload bytea,
  error jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  final_rejected boolean NOT NULL DEFAULT false,
  UNIQUE (source_topic, partition, "offset")
);

-- Down Migration
DROP TABLE core.dlq_message;
DROP TABLE core.device_events;
DROP TABLE core.device_state;
