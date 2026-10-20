ALTER TABLE moni_state ADD COLUMN restore_id TEXT;
ALTER TABLE moni_state ADD COLUMN restore_token TEXT;
ALTER TABLE moni_state ADD COLUMN restore_expires_at INTEGER;

CREATE TABLE restore_sessions (
  id TEXT PRIMARY KEY,
  preparation_id TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  target_dataset TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('locked','downloaded','activated','cancelled')),
  backup_digest TEXT,
  backup_revision INTEGER,
  confirmation_id TEXT,
  confirmation_hash TEXT,
  retire_after INTEGER,
  retired_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX restore_session_expiry ON restore_sessions(status,expires_at);
