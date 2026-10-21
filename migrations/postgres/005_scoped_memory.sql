-- Separate durable preferences/approved organizational guidance from task events.
CREATE TABLE app.long_term_memory (
  id text PRIMARY KEY,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  source_key text,
  child_fields jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);
CREATE TABLE app.episodic_memory (LIKE app.long_term_memory INCLUDING ALL);
CREATE INDEX long_term_memory_owner_idx ON app.long_term_memory ((payload->>'owner'), (payload->>'scope'));
CREATE INDEX episodic_memory_owner_idx ON app.episodic_memory ((payload->>'owner'), created_at DESC);
