CREATE TABLE restore_preparations (
  id TEXT PRIMARY KEY,
  source_dataset TEXT NOT NULL,
  target_dataset TEXT NOT NULL UNIQUE,
  digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('loading','sealed','cancelled','failed','activated')),
  progress INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  header_json TEXT NOT NULL CHECK(json_valid(header_json)),
  summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX restore_expiry ON restore_preparations(status,expires_at);

-- A deleted refund can outlive a legitimate later change to its original expense.
DROP TRIGGER refund_link_valid;
CREATE TRIGGER refund_link_valid BEFORE INSERT ON refund_links
BEGIN
  SELECT RAISE(ABORT, 'invalid refund association') WHERE NOT EXISTS (
    SELECT 1 FROM entries r JOIN entries p ON p.dataset_id = r.dataset_id
    WHERE r.dataset_id = NEW.dataset_id AND r.id = NEW.refund_id AND r.kind = 'refund'
      AND p.id = NEW.expense_id AND p.kind <> 'refund'
      AND (r.deleted_at IS NOT NULL OR (p.kind = 'expense' AND p.deleted_at IS NULL AND r.currency = p.currency
        AND r.original_minor + coalesce((SELECT sum(x.original_minor) FROM refund_links l JOIN entries x
          ON x.dataset_id = l.dataset_id AND x.id = l.refund_id
          WHERE l.dataset_id = NEW.dataset_id AND l.expense_id = NEW.expense_id AND x.deleted_at IS NULL),0) <= p.original_minor))
  );
END;
