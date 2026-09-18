CREATE TABLE app.ui_chat_sessions (
  account_id text NOT NULL REFERENCES app.accounts(id) ON DELETE CASCADE,
  id text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, id)
);
CREATE INDEX ui_chat_sessions_owner_updated ON app.ui_chat_sessions(account_id, updated_at DESC);
