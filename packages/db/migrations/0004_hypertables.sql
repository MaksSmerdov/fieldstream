-- Up Migration
CREATE TABLE ts.readings (
  ts timestamptz NOT NULL,
  device_id integer NOT NULL,
  metric_key text NOT NULL,
  value double precision,
  quality smallint NOT NULL DEFAULT 0
);

SELECT create_hypertable('ts.readings', 'ts', chunk_time_interval => INTERVAL '1 day');

CREATE UNIQUE INDEX readings_device_metric_ts ON ts.readings (device_id, metric_key, ts DESC);

ALTER TABLE ts.readings SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id, metric_key',
  timescaledb.compress_orderby = 'ts DESC'
);

CREATE TABLE ts.poll_cycles (
  ts timestamptz NOT NULL,
  line_id smallint NOT NULL,
  device_id integer NOT NULL,
  ok boolean NOT NULL,
  error_kind text,
  duration_ms integer NOT NULL,
  request_count smallint NOT NULL,
  plan_mode text NOT NULL
);

SELECT create_hypertable('ts.poll_cycles', 'ts', chunk_time_interval => INTERVAL '6 hours');

CREATE UNIQUE INDEX poll_cycles_device_ts ON ts.poll_cycles (device_id, ts DESC);

ALTER TABLE ts.poll_cycles SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'line_id, device_id',
  timescaledb.compress_orderby = 'ts DESC'
);

-- Down Migration
DROP TABLE ts.poll_cycles;
DROP TABLE ts.readings;
