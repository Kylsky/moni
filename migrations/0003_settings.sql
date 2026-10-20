CREATE TABLE datasets (
  id TEXT PRIMARY KEY,
  primary_currency TEXT NOT NULL DEFAULT 'CNY',
  time_zone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  initialized INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0, 1)),
  currency_locked INTEGER NOT NULL DEFAULT 0 CHECK (currency_locked IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 0
);
INSERT INTO datasets(id) VALUES ('initial');

CREATE TABLE operation_receipts (
  dataset_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY(dataset_id, operation_id)
);
