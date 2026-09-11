-- Up Migration
GRANT USAGE ON SCHEMA core, ts TO fs_ingest, fs_api;

GRANT SELECT ON core.sites, core.gateways, core.lines, core.devices,
  core.device_profiles, core.metric_defs TO fs_ingest, fs_api;

GRANT SELECT, INSERT ON ts.readings, ts.poll_cycles TO fs_ingest;
GRANT SELECT, INSERT, UPDATE ON core.device_state, core.dlq_message TO fs_ingest;
GRANT SELECT, INSERT ON core.device_events TO fs_ingest;

GRANT SELECT ON ts.readings, ts.readings_1m, ts.readings_1h, ts.v_readings_1m, ts.v_readings_1h,
  ts.poll_cycles, ts.poll_cycles_5m, ts.device_timeout_hint TO fs_api;
GRANT SELECT ON core.device_state, core.device_events, core.dlq_message TO fs_api;

-- Down Migration
REVOKE ALL ON ALL TABLES IN SCHEMA core, ts FROM fs_ingest, fs_api;
REVOKE USAGE ON SCHEMA core, ts FROM fs_ingest, fs_api;
