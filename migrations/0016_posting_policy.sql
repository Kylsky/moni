CREATE TABLE posting_policy (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  dataset_id TEXT,
  mode TEXT NOT NULL DEFAULT 'review' CHECK (mode IN ('review','automatic')),
  version INTEGER NOT NULL DEFAULT 0
);
INSERT INTO posting_policy(singleton) VALUES (1);
