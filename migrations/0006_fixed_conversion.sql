-- Rebuild to allow a positive original amount that rounds to zero in the base currency.
-- Preserve tag associations before dropping the table with cascading foreign keys.
CREATE TABLE entry_tags_upgrade AS SELECT * FROM entry_tags;
DROP TABLE entry_tags;
CREATE TABLE entries_next (
  dataset_id TEXT NOT NULL REFERENCES datasets(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('income', 'expense', 'refund')),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  entry_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  original_minor INTEGER NOT NULL CHECK(typeof(original_minor) = 'integer' AND original_minor BETWEEN 1 AND 9000000000000),
  base_minor INTEGER NOT NULL CHECK(typeof(base_minor) = 'integer' AND base_minor BETWEEN 0 AND 9000000000000),
  conversion_json TEXT CHECK(conversion_json IS NULL OR json_valid(conversion_json)),
  category_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 2000),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY(dataset_id, id),
  FOREIGN KEY(dataset_id, category_id) REFERENCES categories(dataset_id, id)
);

INSERT INTO entries_next(dataset_id,id,kind,name,entry_date,currency,original_minor,base_minor,category_id,note,version,created_at,updated_at,deleted_at)
SELECT dataset_id,id,kind,name,entry_date,currency,original_minor,base_minor,category_id,note,version,created_at,updated_at,deleted_at FROM entries;
DROP TABLE entries;
ALTER TABLE entries_next RENAME TO entries;
CREATE INDEX entries_date ON entries(dataset_id, deleted_at, entry_date, id);
CREATE TABLE entry_tags (
  dataset_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY(dataset_id, entry_id, tag_id),
  FOREIGN KEY(dataset_id, entry_id) REFERENCES entries(dataset_id, id) ON DELETE CASCADE,
  FOREIGN KEY(dataset_id, tag_id) REFERENCES tags(dataset_id, id)
);

CREATE TRIGGER entry_tag_canonical_insert BEFORE INSERT ON entry_tags
BEGIN
  SELECT RAISE(ABORT, 'entry tag must be canonical') WHERE NOT EXISTS (
    SELECT 1 FROM tags WHERE dataset_id = NEW.dataset_id AND id = NEW.tag_id AND merged_into IS NULL
  );
END;

INSERT INTO entry_tags SELECT dataset_id,entry_id,tag_id FROM entry_tags_upgrade;
DROP TABLE entry_tags_upgrade;
