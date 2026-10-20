CREATE TABLE chat_requests (
  dataset_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (dataset_id, run_id)
);
