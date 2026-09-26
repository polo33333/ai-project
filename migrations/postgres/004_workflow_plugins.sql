-- Phase 1: independent versioned definitions and resumable run checkpoints.
CREATE TABLE app.workflow_catalog (
  id text PRIMARY KEY,
  revision bigint NOT NULL CHECK (revision > 0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document)='object' AND document->>'id'=id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.automation_runs (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  conversation_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('CREATED','WAITING_INPUT','READY','RUNNING','NEEDS_REVIEW','SUCCEEDED','FAILED','CANCELLED')),
  revision bigint NOT NULL CHECK (revision > 0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document)='object' AND document->>'id'=id AND document->>'ownerId'=owner_id AND document->>'conversationId'=conversation_id AND document->>'status'=status),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX automation_owner_conversation_idx ON app.automation_runs(owner_id, conversation_id, updated_at DESC);
CREATE INDEX automation_status_idx ON app.automation_runs(status, updated_at);
-- The document contains pinned definition/overlay versions, step attempts,
-- events and artifact references. CAS updates keep each checkpoint atomic.
