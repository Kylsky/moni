CREATE TABLE fx_quotes (
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  currency TEXT NOT NULL,
  base_currency TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  PRIMARY KEY (dataset_id, id)
);
