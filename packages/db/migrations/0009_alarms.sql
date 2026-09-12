-- Up Migration
CREATE TABLE core.alarm_rules (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id integer NOT NULL REFERENCES core.devices (id),
  metric_key text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('cooling', 'defrost', 'service', 'off')),
  min_value double precision,
  max_value double precision,
  hysteresis double precision NOT NULL DEFAULT 0 CHECK (hysteresis >= 0),
  debounce_cycles smallint NOT NULL DEFAULT 1 CHECK (debounce_cycles BETWEEN 1 AND 60),
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  enabled boolean NOT NULL DEFAULT true,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, metric_key, mode),
  CHECK (min_value IS NOT NULL OR max_value IS NOT NULL),
  CHECK (min_value IS NULL OR max_value IS NULL OR min_value < max_value)
);

-- Прибор и метрика лежат рядом с правилом: история правок читается и после удаления уставки
CREATE TABLE core.alarm_rule_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id integer REFERENCES core.alarm_rules (id) ON DELETE SET NULL,
  device_id integer NOT NULL REFERENCES core.devices (id),
  metric_key text NOT NULL,
  mode text NOT NULL,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  diff jsonb NOT NULL
);

CREATE INDEX alarm_rule_audit_recent ON core.alarm_rule_audit (device_id, changed_at DESC);

-- Одна строка на эпизод: подъём создаёт её, снятие дописывает cleared_at.
-- Состояние выводится из cleared_at, отдельной колонки нет, поэтому разойтись им негде
CREATE TABLE core.alarm_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id integer NOT NULL REFERENCES core.devices (id),
  metric_key text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('cooling', 'defrost', 'service', 'off')),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  boundary text NOT NULL CHECK (boundary IN ('min', 'max')),
  value double precision,
  threshold double precision,
  occurred_at timestamptz NOT NULL,
  cleared_at timestamptz,
  cleared_value double precision,
  dedupe_key text NOT NULL UNIQUE,
  acked_by text,
  acked_at timestamptz,
  CHECK (cleared_at IS NULL OR cleared_at >= occurred_at)
);

CREATE INDEX alarm_events_active ON core.alarm_events (device_id, occurred_at DESC)
  WHERE cleared_at IS NULL;
CREATE INDEX alarm_events_feed ON core.alarm_events (occurred_at DESC, id);
CREATE INDEX alarm_events_device ON core.alarm_events (device_id, occurred_at DESC);

GRANT SELECT ON core.alarm_rules TO fs_ingest;
GRANT SELECT, INSERT, UPDATE ON core.alarm_events TO fs_ingest;

GRANT SELECT, INSERT, UPDATE ON core.alarm_rules TO fs_api;
GRANT SELECT, INSERT ON core.alarm_rule_audit TO fs_api;
-- Интерфейс подтверждает аларм, но не может ни создать его, ни переписать значение
GRANT SELECT ON core.alarm_events TO fs_api;
GRANT UPDATE (acked_by, acked_at) ON core.alarm_events TO fs_api;

-- Down Migration
DROP TABLE core.alarm_events;
DROP TABLE core.alarm_rule_audit;
DROP TABLE core.alarm_rules;
