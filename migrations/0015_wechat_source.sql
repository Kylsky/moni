ALTER TABLE conversations ADD COLUMN source TEXT NOT NULL DEFAULT 'web' CHECK(source IN ('web','wechat'));

-- Execution authority is deployment state, deliberately excluded from business backups.
CREATE TABLE wechat_binding (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  epoch TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1))
);
