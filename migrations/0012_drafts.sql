CREATE TABLE drafts (
  dataset_id TEXT NOT NULL REFERENCES datasets(id),
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  status TEXT NOT NULL CHECK(status IN ('needs_details','ready','posted','cancelled')),
  base_currency TEXT NOT NULL,
  items_json TEXT NOT NULL CHECK(json_valid(items_json)),
  total_base_minor INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(dataset_id,id),
  FOREIGN KEY(dataset_id,thread_id) REFERENCES conversations(dataset_id,id)
);
CREATE INDEX drafts_thread ON drafts(dataset_id,thread_id,created_at);
