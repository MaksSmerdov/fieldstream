-- Up Migration
-- Перепрогоны окна истории с правкой уставок: шлюз кладёт запрос со снимком уставок обоих
-- вариантов, процессор забирает его, перечитывает сырые кадры во временной группе и пишет ход,
-- покрытие окна и эпизоды. Снимок лежит в строке, поэтому прогон воспроизводим. Прогон длинный:
-- исполнитель отмечает пульс, а на стенде идёт только один прогон
CREATE TABLE core.replay_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by text NOT NULL,
  from_ts timestamptz NOT NULL,
  to_ts timestamptz NOT NULL,
  device_codes text[] NOT NULL,
  patches jsonb NOT NULL,
  rules_baseline jsonb NOT NULL,
  rules_patched jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed')),
  offsets_total bigint NOT NULL DEFAULT 0 CHECK (offsets_total >= 0),
  offsets_done bigint NOT NULL DEFAULT 0 CHECK (offsets_done >= 0),
  frames_matched integer NOT NULL DEFAULT 0 CHECK (frames_matched >= 0),
  frames_rejected integer NOT NULL DEFAULT 0 CHECK (frames_rejected >= 0),
  covered_from timestamptz,
  covered_to timestamptz,
  group_id text,
  instance_id text,
  heartbeat_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  CHECK (to_ts > from_ts),
  CHECK (cardinality(device_codes) BETWEEN 1 AND 24)
);

CREATE INDEX replay_run_recent ON core.replay_run (created_at DESC);
CREATE UNIQUE INDEX replay_run_one_active ON core.replay_run ((true))
  WHERE status IN ('queued', 'running');

-- Эпизоды алармов обоих вариантов прогона: удаляются вместе с прогоном
CREATE TABLE core.replay_alarm_episode (
  run_id uuid NOT NULL REFERENCES core.replay_run (id) ON DELETE CASCADE,
  variant text NOT NULL CHECK (variant IN ('baseline', 'patched')),
  device_id integer NOT NULL REFERENCES core.devices (id),
  metric_key text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('cooling', 'defrost', 'service', 'off')),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  boundary text NOT NULL CHECK (boundary IN ('min', 'max')),
  value double precision,
  threshold double precision,
  raised_at timestamptz NOT NULL,
  cleared_at timestamptz,
  cleared_value double precision,
  PRIMARY KEY (run_id, variant, device_id, metric_key, raised_at),
  CHECK (cleared_at IS NULL OR cleared_at >= raised_at)
);

GRANT SELECT ON core.replay_run, core.replay_alarm_episode TO fs_api;
GRANT INSERT (requested_by, from_ts, to_ts, device_codes, patches, rules_baseline, rules_patched)
  ON core.replay_run TO fs_api;
-- Интерфейс снимает с очереди прогон, который ни один процессор не забрал: иначе стенд занят навсегда
GRANT UPDATE (status, error, finished_at) ON core.replay_run TO fs_api;

-- Процессор пишет ход, итог и эпизоды. Окно, приборы, правку и снимок уставок после постановки
-- не меняет никто, эпизоды удаляются только вместе с прогоном
GRANT SELECT, DELETE ON core.replay_run TO fs_ingest;
GRANT UPDATE (status, offsets_total, offsets_done, frames_matched, frames_rejected, covered_from,
  covered_to, group_id, instance_id, heartbeat_at, error, started_at, finished_at)
  ON core.replay_run TO fs_ingest;
GRANT SELECT, INSERT ON core.replay_alarm_episode TO fs_ingest;

-- Down Migration
DROP TABLE core.replay_alarm_episode;
DROP TABLE core.replay_run;
