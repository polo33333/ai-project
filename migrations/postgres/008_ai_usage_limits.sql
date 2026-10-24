-- Token limits and locks for AI calls, per account and per AI provider.
CREATE TABLE app.ai_usage_limits (
  scope text NOT NULL CHECK (scope IN ('account','provider')),
  target_id text NOT NULL,
  period text NOT NULL CHECK (period IN ('day','month')),
  token_limit bigint CHECK (token_limit IS NULL OR token_limit >= 0),
  locked boolean NOT NULL DEFAULT false,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, target_id)
);
-- One row per target and period bucket ('d:YYYY-MM-DD' or 'm:YYYY-MM', Vietnam time);
-- increments are atomic upserts so concurrent requests never lose tokens.
CREATE TABLE app.ai_usage_counters (
  scope text NOT NULL CHECK (scope IN ('account','provider')),
  target_id text NOT NULL,
  period_key text NOT NULL,
  tokens bigint NOT NULL DEFAULT 0,
  requests bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, target_id, period_key)
);
