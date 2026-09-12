-- Up Migration
-- Стадии готовности стенда: засев истории и сервисы отмечаются здесь,
-- интерфейс показывает по ним загрузочную панель вместо пустых экранов
CREATE TABLE core.boot_progress (
  stage text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
  detail text,
  progress_pct smallint NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON core.boot_progress TO fs_api;
GRANT SELECT, INSERT, UPDATE ON core.boot_progress TO fs_ingest;

-- Down Migration
DROP TABLE core.boot_progress;
