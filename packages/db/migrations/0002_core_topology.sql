-- Up Migration
CREATE TABLE core.sites (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  timezone text NOT NULL
);

CREATE TABLE core.gateways (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id smallint NOT NULL REFERENCES core.sites (id),
  code text NOT NULL UNIQUE,
  host text NOT NULL
);

CREATE TABLE core.lines (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gateway_id smallint NOT NULL REFERENCES core.gateways (id),
  code text NOT NULL UNIQUE,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  baud integer NOT NULL CHECK (baud > 0),
  poll_interval_ms integer NOT NULL DEFAULT 10000,
  request_timeout_ms integer NOT NULL DEFAULT 600,
  plan_mode text NOT NULL DEFAULT 'merged' CHECK (plan_mode IN ('merged', 'naive')),
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE core.device_profiles (
  profile_key text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  config jsonb NOT NULL,
  checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_key, version)
);

CREATE TABLE core.metric_defs (
  profile_key text NOT NULL,
  metric_key text NOT NULL,
  label text NOT NULL,
  unit text,
  kind text NOT NULL CHECK (kind IN ('number', 'enum', 'bits')),
  precision smallint NOT NULL,
  PRIMARY KEY (profile_key, metric_key)
);

CREATE TABLE core.devices (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  line_id smallint NOT NULL REFERENCES core.lines (id),
  code text NOT NULL UNIQUE,
  profile_key text NOT NULL,
  profile_version integer NOT NULL,
  slave_id smallint NOT NULL CHECK (slave_id BETWEEN 1 AND 247),
  label text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  installed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (line_id, slave_id),
  FOREIGN KEY (profile_key, profile_version) REFERENCES core.device_profiles (profile_key, version)
);

-- Down Migration
DROP TABLE core.devices;
DROP TABLE core.metric_defs;
DROP TABLE core.device_profiles;
DROP TABLE core.lines;
DROP TABLE core.gateways;
DROP TABLE core.sites;
