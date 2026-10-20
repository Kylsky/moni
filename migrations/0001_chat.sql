CREATE TABLE moni_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_dataset TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO moni_state (singleton, active_dataset) VALUES (1, 'initial');

CREATE TABLE invariant_assertions (valid INTEGER NOT NULL CHECK (valid = 1));

CREATE TABLE chat_messages (
  dataset_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  PRIMARY KEY (dataset_id, thread_id, position)
);

CREATE TABLE chat_runs (
  dataset_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT,
  error_code TEXT,
  usage_json TEXT,
  sandbox_key TEXT,
  detached_since INTEGER,
  cancel_requested INTEGER,
  driver_epoch INTEGER,
  parent_run_id TEXT,
  subagent_run_id TEXT,
  name TEXT,
  PRIMARY KEY (dataset_id, run_id)
);
CREATE INDEX chat_runs_thread ON chat_runs (dataset_id, thread_id, started_at);
CREATE INDEX chat_runs_parent ON chat_runs (dataset_id, parent_run_id, started_at);

CREATE TABLE chat_interrupts (
  dataset_id TEXT NOT NULL,
  interrupt_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at INTEGER NOT NULL,
  resolved_at INTEGER,
  payload_json TEXT NOT NULL,
  response_json TEXT,
  PRIMARY KEY (dataset_id, interrupt_id)
);
CREATE INDEX chat_interrupts_thread ON chat_interrupts (dataset_id, thread_id, requested_at);
CREATE INDEX chat_interrupts_run ON chat_interrupts (dataset_id, run_id, requested_at);

CREATE TABLE chat_metadata (
  dataset_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  revision TEXT NOT NULL,
  PRIMARY KEY (dataset_id, namespace, key)
);

CREATE TABLE chat_permits (
  dataset_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (dataset_id, thread_id)
);
