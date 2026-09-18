-- Normalized legacy import foundation. Runtime cutover requires async service repositories.
CREATE TABLE app.storage_state (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), mode text NOT NULL CHECK(mode IN ('staging','live')));
INSERT INTO app.storage_state VALUES (true, 'staging');
CREATE TABLE app.import_batches (id text PRIMARY KEY, snapshot_hash text UNIQUE NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(), report jsonb NOT NULL);
CREATE TABLE app.import_files (file text PRIMARY KEY, batch_id text NOT NULL REFERENCES app.import_batches(id), metadata jsonb NOT NULL);

CREATE TABLE app.accounts (
  id text PRIMARY KEY,
  
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.auth_sessions (
  id text PRIMARY KEY,
  account_id text REFERENCES app.accounts(id) ON DELETE CASCADE, expires_at timestamptz,
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.api_keys (
  id text PRIMARY KEY,
  key_hash text UNIQUE,
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.data_sources (
  id text PRIMARY KEY,
  
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.ai_providers (
  id text PRIMARY KEY,
  
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.ai_personas (
  id text PRIMARY KEY,
  
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.embed_configs (
  id text PRIMARY KEY,
  
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.mcp_servers (
  id text PRIMARY KEY,
  
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.dictionary_tables (
  id text PRIMARY KEY,
  data_source_id text REFERENCES app.data_sources(id) ON DELETE SET NULL, schema_name text, table_name text,
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.table_relationships (
  id text PRIMARY KEY,
  
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.glossary_terms (
  id text PRIMARY KEY,
  
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.alias_domains (
  id text PRIMARY KEY,
  
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.skills (
  id text PRIMARY KEY,
  
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.chat_runs (
  id text PRIMARY KEY,
  completion_status text NOT NULL,
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.chat_feedback (
  id text PRIMARY KEY,
  run_id text REFERENCES app.chat_runs(id) ON DELETE SET NULL,
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.chat_sessions (
  id text PRIMARY KEY,
  owner_scope text NOT NULL, client_session_id text NOT NULL, account_id text REFERENCES app.accounts(id) ON DELETE RESTRICT, UNIQUE(owner_scope, client_session_id),
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.system_logs (
  id text PRIMARY KEY,
  
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.workflows (
  id text PRIMARY KEY,
  
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.workflow_runs (
  id text PRIMARY KEY,
  workflow_id text REFERENCES app.workflows(id) ON DELETE SET NULL,
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.documents (
  id text PRIMARY KEY,
  
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.watchfolders (
  id text PRIMARY KEY,
  
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.watchfolder_runs (
  id text PRIMARY KEY,
  
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.training_resolutions (
  id text PRIMARY KEY,
  
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.regression_cases (
  id text PRIMARY KEY,
  
  
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.dictionary_columns (
  id text PRIMARY KEY,
  
  parent_id text NOT NULL REFERENCES app.dictionary_tables(id) ON DELETE CASCADE, UNIQUE(parent_id, ordinal),
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.chat_messages (
  id text PRIMARY KEY,
  
  parent_id text NOT NULL REFERENCES app.chat_sessions(id) ON DELETE CASCADE, UNIQUE(parent_id, ordinal),
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.tool_executions (
  id text PRIMARY KEY,
  
  parent_id text NOT NULL REFERENCES app.chat_runs(id) ON DELETE CASCADE, UNIQUE(parent_id, ordinal),
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.workflow_steps (
  id text PRIMARY KEY,
  
  parent_id text NOT NULL REFERENCES app.workflows(id) ON DELETE CASCADE, UNIQUE(parent_id, ordinal),
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.domain_aliases (
  id text PRIMARY KEY,
  
  parent_id text NOT NULL REFERENCES app.alias_domains(id) ON DELETE CASCADE, UNIQUE(parent_id, ordinal),
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.memory_states (
  id text PRIMARY KEY,
  
  parent_id text NOT NULL REFERENCES app.chat_sessions(id) ON DELETE CASCADE, UNIQUE(parent_id, ordinal),
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);

CREATE INDEX chat_runs_created_idx ON app.chat_runs(created_at DESC, id);
CREATE INDEX chat_runs_status_idx ON app.chat_runs(completion_status, created_at DESC);
CREATE INDEX feedback_run_idx ON app.chat_feedback(run_id);
CREATE INDEX auth_expiry_idx ON app.auth_sessions(expires_at);
CREATE INDEX dictionary_source_idx ON app.dictionary_tables(data_source_id, schema_name, table_name);
