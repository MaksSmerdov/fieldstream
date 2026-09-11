-- Up Migration
SELECT add_compression_policy('ts.readings', INTERVAL '2 days');
SELECT add_retention_policy('ts.readings', INTERVAL '30 days');
SELECT add_compression_policy('ts.poll_cycles', INTERVAL '2 days');
SELECT add_retention_policy('ts.poll_cycles', INTERVAL '30 days');

SELECT add_continuous_aggregate_policy('ts.readings_1m',
  start_offset => INTERVAL '2 hours',
  end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');

SELECT add_continuous_aggregate_policy('ts.readings_1h',
  start_offset => INTERVAL '3 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '15 minutes');

SELECT add_continuous_aggregate_policy('ts.poll_cycles_5m',
  start_offset => INTERVAL '1 day',
  end_offset => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes');

SELECT add_retention_policy('ts.readings_1m', INTERVAL '1 year');
SELECT add_retention_policy('ts.readings_1h', INTERVAL '3 years');
SELECT add_retention_policy('ts.poll_cycles_5m', INTERVAL '90 days');

-- Down Migration
SELECT remove_retention_policy('ts.poll_cycles_5m');
SELECT remove_retention_policy('ts.readings_1h');
SELECT remove_retention_policy('ts.readings_1m');
SELECT remove_continuous_aggregate_policy('ts.poll_cycles_5m');
SELECT remove_continuous_aggregate_policy('ts.readings_1h');
SELECT remove_continuous_aggregate_policy('ts.readings_1m');
SELECT remove_retention_policy('ts.poll_cycles');
SELECT remove_compression_policy('ts.poll_cycles');
SELECT remove_retention_policy('ts.readings');
SELECT remove_compression_policy('ts.readings');
