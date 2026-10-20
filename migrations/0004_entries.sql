CREATE TABLE categories (
  dataset_id TEXT NOT NULL REFERENCES datasets(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('income', 'expense')),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 50),
  default_key TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(dataset_id, id),
  UNIQUE(dataset_id, kind, name)
);
WITH defaults(id, kind, name) AS (VALUES
  ('expense-uncategorized', 'expense', '未分类'),
  ('expense-food', 'expense', '饮食'),
  ('expense-sports', 'expense', '运动'),
  ('expense-clothing', 'expense', '穿搭'),
  ('expense-transport', 'expense', '出行'),
  ('expense-home', 'expense', '居住'),
  ('expense-entertainment', 'expense', '娱乐'),
  ('expense-other', 'expense', '其他'),
  ('income-uncategorized', 'income', '未分类'),
  ('income-salary', 'income', '工资'),
  ('income-freelance', 'income', '兼职'),
  ('income-other', 'income', '其他')
)
INSERT INTO categories(dataset_id, id, kind, name, default_key)
SELECT d.id, c.id, c.kind, c.name, c.id FROM datasets d CROSS JOIN defaults c;

CREATE TABLE tags (
  dataset_id TEXT NOT NULL REFERENCES datasets(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 30),
  normalized_name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(dataset_id, id),
  UNIQUE(dataset_id, normalized_name)
);

CREATE TABLE entries (
  dataset_id TEXT NOT NULL REFERENCES datasets(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('income', 'expense', 'refund')),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  entry_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  original_minor INTEGER NOT NULL CHECK(typeof(original_minor) = 'integer' AND original_minor BETWEEN 1 AND 9000000000000),
  base_minor INTEGER NOT NULL CHECK(typeof(base_minor) = 'integer' AND base_minor BETWEEN 1 AND 9000000000000),
  category_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 2000),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY(dataset_id, id),
  FOREIGN KEY(dataset_id, category_id) REFERENCES categories(dataset_id, id)
);
CREATE INDEX entries_date ON entries(dataset_id, deleted_at, entry_date, id);

CREATE TABLE entry_tags (
  dataset_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY(dataset_id, entry_id, tag_id),
  FOREIGN KEY(dataset_id, entry_id) REFERENCES entries(dataset_id, id) ON DELETE CASCADE,
  FOREIGN KEY(dataset_id, tag_id) REFERENCES tags(dataset_id, id)
);
