CREATE TABLE app.account_roles (
  id text PRIMARY KEY,
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);
