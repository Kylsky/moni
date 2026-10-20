CREATE TABLE conversations (
  dataset_id TEXT NOT NULL REFERENCES datasets(id),
  id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '' CHECK(length(title) <= 80),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY(dataset_id, id)
);
CREATE INDEX conversations_recent ON conversations(dataset_id, deleted_at, updated_at, id);
ALTER TABLE chat_requests ADD COLUMN user_message_id TEXT;
