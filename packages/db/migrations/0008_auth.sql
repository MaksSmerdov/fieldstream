-- Up Migration
CREATE TABLE core.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer', 'engineer', 'admin')),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Почта сравнивается без учёта регистра, расширение citext ради одной колонки не ставится
CREATE UNIQUE INDEX users_email ON core.users (lower(email));

CREATE TABLE core.user_permissions (
  user_id uuid NOT NULL REFERENCES core.users (id) ON DELETE CASCADE,
  module_id text NOT NULL,
  effect text NOT NULL CHECK (effect IN ('grant', 'deny')),
  PRIMARY KEY (user_id, module_id)
);

-- prev_token_hash держит предыдущий токен пары: по нему повтор потерянного ответа
-- узнаётся как повтор, а не как кража токена
CREATE TABLE core.refresh_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES core.users (id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  prev_token_hash text UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  expires_at timestamptz NOT NULL,
  user_agent text,
  ip inet,
  revoked_at timestamptz
);

CREATE INDEX refresh_sessions_live ON core.refresh_sessions (user_id, session_id)
  WHERE revoked_at IS NULL;

CREATE TABLE core.rate_limit (
  bucket_key text PRIMARY KEY,
  tokens integer NOT NULL CHECK (tokens >= 0),
  refilled_at timestamptz NOT NULL
);

GRANT SELECT ON core.users, core.user_permissions TO fs_api;
GRANT SELECT, INSERT, UPDATE ON core.refresh_sessions, core.rate_limit TO fs_api;

-- Down Migration
DROP TABLE core.rate_limit;
DROP TABLE core.refresh_sessions;
DROP TABLE core.user_permissions;
DROP TABLE core.users;
