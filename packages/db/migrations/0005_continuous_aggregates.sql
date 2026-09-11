-- Up Migration
CREATE MATERIALIZED VIEW ts.readings_1m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 minute', ts) AS bucket,
  device_id,
  metric_key,
  sum(value) AS sum_value,
  count(value) AS n,
  min(value) AS min_value,
  max(value) AS max_value,
  last(value, ts) AS last_value
FROM ts.readings
GROUP BY 1, 2, 3
WITH NO DATA;

CREATE MATERIALIZED VIEW ts.readings_1h
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 hour', bucket) AS bucket,
  device_id,
  metric_key,
  sum(sum_value) AS sum_value,
  sum(n) AS n,
  min(min_value) AS min_value,
  max(max_value) AS max_value,
  last(last_value, bucket) AS last_value
FROM ts.readings_1m
GROUP BY 1, 2, 3
WITH NO DATA;

CREATE VIEW ts.v_readings_1m AS
SELECT bucket, device_id, metric_key, sum_value / NULLIF(n, 0) AS avg_value,
       min_value, max_value, last_value, n
FROM ts.readings_1m;

CREATE VIEW ts.v_readings_1h AS
SELECT bucket, device_id, metric_key, sum_value / NULLIF(n, 0) AS avg_value,
       min_value, max_value, last_value, n
FROM ts.readings_1h;

CREATE MATERIALIZED VIEW ts.poll_cycles_5m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '5 minutes', ts) AS bucket,
  line_id,
  device_id,
  percentile_agg(duration_ms) AS pct,
  count(*) FILTER (WHERE ok) AS ok_count,
  count(*) FILTER (WHERE error_kind = 'timeout') AS timeouts,
  count(*) FILTER (WHERE error_kind = 'crc') AS crc_errors,
  count(*) FILTER (WHERE error_kind = 'exception') AS exceptions,
  count(*) FILTER (WHERE error_kind = 'stalled') AS stalled,
  count(*) FILTER (WHERE error_kind = 'disconnected') AS disconnects,
  count(*) AS samples
FROM ts.poll_cycles
GROUP BY 1, 2, 3
WITH NO DATA;

CREATE VIEW ts.device_timeout_hint AS
SELECT
  device_id,
  greatest(500, ceil(approx_percentile(0.99, rollup(pct)) * 5 / 100.0) * 100) AS suggested_timeout_ms,
  sum(samples) AS sample_count
FROM ts.poll_cycles_5m
WHERE bucket > now() - INTERVAL '6 hours'
GROUP BY device_id
HAVING sum(samples) >= 100;

-- Down Migration
DROP VIEW ts.device_timeout_hint;
DROP MATERIALIZED VIEW ts.poll_cycles_5m;
DROP VIEW ts.v_readings_1h;
DROP VIEW ts.v_readings_1m;
DROP MATERIALIZED VIEW ts.readings_1h;
DROP MATERIALIZED VIEW ts.readings_1m;
