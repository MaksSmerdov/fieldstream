-- Up Migration
-- Прогоны сценариев стенда: шлюз исполняет прогон и пишет сюда ход по шагам, интерфейс и CI
-- следят за ним по номеру. Прогон вносит настоящие поломки, поэтому на стенде идёт только один.
-- Экземпляр шлюза, исполняющий прогон, отмечает пульс: прогон с протухшим пульсом брошен
CREATE TABLE core.scenario_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario text NOT NULL,
  title text NOT NULL,
  source text NOT NULL CHECK (source IN ('ui', 'ci')),
  requested_by text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'passed', 'failed')),
  steps jsonb NOT NULL DEFAULT '[]',
  error text,
  instance_id text,
  heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX scenario_run_recent ON core.scenario_run (scenario, created_at DESC);
CREATE UNIQUE INDEX scenario_run_one_active ON core.scenario_run ((true))
  WHERE status IN ('queued', 'running');

GRANT SELECT, INSERT, UPDATE ON core.scenario_run TO fs_api;

-- Down Migration
DROP TABLE core.scenario_run;
