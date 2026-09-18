-- Import manifests are immutable. Runtime wrapper metadata lives separately.
CREATE TABLE app.domain_stores (
  file text PRIMARY KEY,
  root jsonb NOT NULL DEFAULT '{}',
  revision bigint NOT NULL DEFAULT 1
);
INSERT INTO app.domain_stores(file, root)
SELECT file, metadata->'root' FROM app.import_files;

CREATE TABLE app.operation_commits (
  operation_id text PRIMARY KEY,
  committed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.chat_request_receipts (
  key text PRIMARY KEY,
  body_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.worker_leases (
  key text PRIMARY KEY,
  owner text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE app.outbox_jobs (
  id text PRIMARY KEY,
  kind text NOT NULL,
  resource_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON app.outbox_jobs(status, available_at);

ALTER TABLE app.chat_runs ADD COLUMN session_id text REFERENCES app.chat_sessions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE app.chat_runs ADD COLUMN request_id text;
CREATE INDEX chat_run_session_idx ON app.chat_runs(session_id, created_at DESC);
CREATE UNIQUE INDEX chat_run_request_idx ON app.chat_runs(request_id) WHERE request_id IS NOT NULL;

ALTER TABLE app.chat_sessions ADD COLUMN embed_id text REFERENCES app.embed_configs(id) ON DELETE RESTRICT;

-- Provider credentials are encrypted; the active flag needs its own typed column.
ALTER TABLE app.ai_providers ADD COLUMN is_active boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX one_active_provider_idx ON app.ai_providers (is_active) WHERE is_active;
